/**
 * Margin/buying-power scenario test against the live DB, proving the gate and
 * liquidation detection end-to-end:
 *   A) over-leverage beyond available margin → rejected ('insufficient_margin'),
 *      no order/position written;
 *   B) adding to a position → margin required scales with the TOTAL resulting
 *      size, and a further add beyond available margin is rejected;
 *   C) a levered position past its liquidation price → correctly detected.
 *
 * Idempotent: wipes its own prior data at the start and leaves fresh rows for
 * inspection. Run: npx tsx server/margin-smoke.ts
 */

import { RoundController } from '@iimb-trading/engine'
import { USD_INR } from './config'
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'

const TICKER = 'AAPL'
const ROUND_ID = 'margin-smoke-round'
const db = createAdminClient()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

async function resolveId(table: 'profiles' | 'instruments', col: string, val: string): Promise<string> {
  const { data, error } = await db.from(table).select('id').eq(col, val).single()
  if (error || !data) throw new Error(`could not resolve ${table}.${col}=${val}: ${error?.message}`)
  return data.id as string
}

async function cleanup(a: string, b: string, instrumentId: string): Promise<void> {
  await db.from('trades').delete().eq('round_id', ROUND_ID)
  await db.from('orders').delete().eq('round_id', ROUND_ID)
  await db.from('positions').delete().in('account_id', [a, b]).eq('instrument_id', instrumentId)
  await db.from('event_log').delete().in('account_id', [a, b]).in('event_type', ['order_placed', 'order_matched', 'order_rejected'])
  await db.from('event_log').delete().in('event_type', ['round_started', 'round_ended']).eq('payload->>roundId', ROUND_ID)
  await db.from('rounds').delete().eq('id', ROUND_ID)
  await db.from('profiles').update({ realized_pnl: 0 }).in('id', [a, b])
}

async function main(): Promise<void> {
  const A = await resolveId('profiles', 'username', 'team01')
  const B = await resolveId('profiles', 'username', 'team02')
  const aapl = await resolveId('instruments', 'ticker', TICKER)
  await cleanup(A, B, aapl)

  const rounds = new RoundController([
    { id: ROUND_ID, mode: 'only_data', durationSeconds: 600, commissionEnabled: false },
  ])
  const svc = new TradingService(db, rounds)
  await svc.loadInstruments()
  await svc.startRound(0)

  const startCashUsd = 1_000_000 / USD_INR // team default cash, in USD ≈ 12,048
  console.log(`\nBuying power per team ≈ $${startCashUsd.toFixed(0)} (₹1,000,000 / ${USD_INR})\n`)

  // --- A) Over-leverage rejection -------------------------------------------
  console.log('A. Over-leverage beyond available margin:')
  const huge = await svc.placeOrder({
    accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 200, qty: 1000, leverage: 1,
  }) // notional $200,000 at 1x ≫ ~$12k available
  check('order rejected', !huge.accepted, huge.reason)
  check("reason is 'insufficient_margin'", huge.reason === 'insufficient_margin')
  const ordersAfterReject = await db.from('orders').select('id', { count: 'exact', head: true }).eq('round_id', ROUND_ID)
  check('no order row written for the rejected order', ordersAfterReject.count === 0, `count=${ordersAfterReject.count}`)
  const stateA0 = await svc.getAccountState(A)
  check('no position opened', stateA0.positions.length === 0)

  // --- B) Add scales with total position size -------------------------------
  console.log('\nB. Adding to a position (margin scales with total size):')
  // B provides resting sell liquidity for A to buy into (200 units @ $100).
  await svc.placeOrder({ accountId: B, ticker: TICKER, side: 'sell', type: 'limit', price: 100, qty: 200, leverage: 5 })

  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 100, leverage: 5 })
  const afterOpen = await svc.getAccountState(A)
  const openMarginUsd = afterOpen.marginUsedInr / USD_INR
  check('open 100 @ 100 (5x) → margin $2,000', Math.abs(openMarginUsd - 2000) < 1, `$${openMarginUsd.toFixed(0)}`)

  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 100, leverage: 5 })
  const afterAdd = await svc.getAccountState(A)
  const addMarginUsd = afterAdd.marginUsedInr / USD_INR
  check('add another 100 → margin scales to $4,000 (2×)', Math.abs(addMarginUsd - 4000) < 1, `$${addMarginUsd.toFixed(0)}`)
  check('position is 200 @ 100', afterAdd.positions[0]?.qty === 200 && Math.abs(afterAdd.positions[0].avgPrice - 100) < 1e-9)

  // A further large add that exceeds remaining available margin is rejected.
  const overAdd = await svc.placeOrder({
    accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 1000, leverage: 5,
  }) // needs $20,000 > ~$8k remaining
  check('further add beyond available margin rejected', !overAdd.accepted && overAdd.reason === 'insufficient_margin', overAdd.reason)
  const afterOverAdd = await svc.getAccountState(A)
  check('position unchanged after rejected add (still 200)', afterOverAdd.positions[0]?.qty === 200)

  // --- C) Liquidation detection ---------------------------------------------
  console.log('\nC. Liquidation price + detection (A long 200 @ 100, 5x):')
  const liq = await svc.getLiquidationPrice(A, TICKER)
  check('liquidation price = 80 (100 × (1 − 1/5))', liq !== null && Math.abs(liq - 80) < 1e-9, `${liq}`)
  check('safe at mark 81 (not liquidatable)', !(await svc.isPositionLiquidatable(A, TICKER, 81)))
  check('liquidatable at mark 80 (at the line)', await svc.isPositionLiquidatable(A, TICKER, 80))
  check('liquidatable at mark 79 (past it)', await svc.isPositionLiquidatable(A, TICKER, 79))

  await svc.endRound(1)

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ Margin smoke test error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
