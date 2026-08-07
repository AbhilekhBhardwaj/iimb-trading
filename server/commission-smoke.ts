/**
 * Commission scenario test against the live DB:
 *   A) commission ON  → every fill charges DEFAULT_COMMISSION_RATE × notional to BOTH
 *      sides, deducted from each account's realized P&L.
 *   B) commission OFF → a fill charges nothing (realized unchanged).
 *
 * Idempotent (wipes its own prior data at the start). Run: npx tsx server/commission-smoke.ts
 */
import { RoundController } from '@iimb-trading/engine'
import { DEFAULT_COMMISSION_RATE, USD_INR } from './config'
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'

const TICKER = 'AAPL'
const R_ON = 'comm-on-round'
const R_OFF = 'comm-off-round'
const db = createAdminClient()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

async function resolveId(table: 'profiles' | 'instruments', col: string, val: string): Promise<string> {
  const { data, error } = await db.from(table).select('id').eq(col, val).single()
  if (error || !data) throw new Error(`could not resolve ${table}.${col}=${val}: ${error?.message}`)
  return data.id as string
}
async function cleanup(a: string, b: string, instrumentId: string): Promise<void> {
  await db.from('trades').delete().in('round_id', [R_ON, R_OFF])
  await db.from('orders').delete().in('round_id', [R_ON, R_OFF])
  await db.from('positions').delete().in('account_id', [a, b]).eq('instrument_id', instrumentId)
  await db.from('event_log').delete().in('account_id', [a, b]).in('event_type', ['order_placed', 'order_matched', 'order_rejected', 'commission_charged'])
  await db.from('event_log').delete().in('event_type', ['round_started', 'round_ended']).in('payload->>roundId', [R_ON, R_OFF])
  await db.from('rounds').delete().in('id', [R_ON, R_OFF])
  await db.from('profiles').update({ realized_pnl: 0 }).in('id', [a, b])
}

async function main(): Promise<void> {
  const A = await resolveId('profiles', 'username', 'team01')
  const B = await resolveId('profiles', 'username', 'team02')
  const aapl = await resolveId('instruments', 'ticker', TICKER)
  await cleanup(A, B, aapl)

  const svc = new TradingService(db, new RoundController([
    { id: R_ON, mode: 'only_data', durationSeconds: 600, commissionEnabled: true },
    { id: R_OFF, mode: 'only_data', durationSeconds: 600, commissionEnabled: false },
  ]))
  await svc.loadInstruments()

  const expCommUsd = DEFAULT_COMMISSION_RATE * 10 * 100 // 0.003 × 10 × 100 = 3.0 USD per side
  const expCommInr = expCommUsd * USD_INR

  // --- A) commission ON ---
  console.log(`\nA. Commission ON (rate ${DEFAULT_COMMISSION_RATE} = ${(DEFAULT_COMMISSION_RATE * 100).toFixed(2)}%):`)
  await svc.startRound(0)
  await svc.placeOrder({ accountId: B, ticker: TICKER, side: 'sell', type: 'limit', price: 100, qty: 10, leverage: 1 })
  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 10, leverage: 1 })

  const a1 = await svc.getAccountState(A)
  const b1 = await svc.getAccountState(B)
  check('buyer charged commission (realized −₹249)', near(a1.realizedPnlInr, -expCommInr, 1), `₹${a1.realizedPnlInr.toFixed(0)} (expected −₹${expCommInr.toFixed(0)})`)
  check('seller charged commission (realized −₹249)', near(b1.realizedPnlInr, -expCommInr, 1), `₹${b1.realizedPnlInr.toFixed(0)}`)
  const { count: commEvents } = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'commission_charged').in('account_id', [A, B])
  check('2 commission_charged audit events (one per side)', commEvents === 2, `count=${commEvents}`)

  // --- B) commission OFF ---
  console.log('\nB. Commission OFF:')
  await svc.endRound(1)
  const beforeA = (await svc.getAccountState(A)).realizedPnlInr
  const beforeB = (await svc.getAccountState(B)).realizedPnlInr
  await svc.startRound(2)
  await svc.placeOrder({ accountId: B, ticker: TICKER, side: 'sell', type: 'limit', price: 100, qty: 10, leverage: 1 })
  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 10, leverage: 1 })

  const a2 = await svc.getAccountState(A)
  const b2 = await svc.getAccountState(B)
  check('buyer charged nothing (realized unchanged)', near(a2.realizedPnlInr, beforeA, 1), `Δ₹${(a2.realizedPnlInr - beforeA).toFixed(2)}`)
  check('seller charged nothing (realized unchanged)', near(b2.realizedPnlInr, beforeB, 1), `Δ₹${(b2.realizedPnlInr - beforeB).toFixed(2)}`)
  const { count: commEventsAfter } = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'commission_charged').in('account_id', [A, B])
  check('still only the 2 commission events (none added while OFF)', commEventsAfter === 2, `count=${commEventsAfter}`)

  await svc.endRound(3)
  console.log(`\n${failures === 0 ? '✅ ALL COMMISSION CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ Commission smoke error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
