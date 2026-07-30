/**
 * Recovery + margin-reservation scenario test against the live DB.
 *
 * Part 0: rehydrate() with nothing to restore → no-op (no server_recovered log).
 * Part 1: two resting limit orders that individually pass margin but would
 *         collectively over-commit → the second is rejected; cancelling the
 *         first releases its reserved margin so the second then succeeds.
 * Part 2: build a mid-scenario state (positions, realized P&L, resting orders
 *         with reserved margin, an active round) with one service, then "crash"
 *         into a fresh service and rehydrate() — confirming the order book,
 *         round state, realized P&L, and reserved margin are all restored, and
 *         that the restored reservation is enforced on the next order.
 *
 * Idempotent; leaves fresh rows for inspection. Run: npx tsx server/recovery-smoke.ts
 */

import { RoundController } from '@iimb-trading/engine'
import { USD_INR } from './config'
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'

const TICKER = 'AAPL'
const P1_ROUND = 'recovery-p1-round'
const P2_ROUND = 'recovery-p2-round'
const db = createAdminClient()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

function controllerFor(roundId: string): RoundController {
  return new RoundController([{ id: roundId, mode: 'only_data', durationSeconds: 600, commissionEnabled: false }])
}

async function resolveId(table: 'profiles' | 'instruments', col: string, val: string): Promise<string> {
  const { data, error } = await db.from(table).select('id').eq(col, val).single()
  if (error || !data) throw new Error(`could not resolve ${table}.${col}=${val}: ${error?.message}`)
  return data.id as string
}

async function cleanupAll(a: string, b: string, instrumentId: string): Promise<void> {
  await db.from('trades').delete().in('round_id', [P1_ROUND, P2_ROUND])
  await db.from('orders').delete().in('round_id', [P1_ROUND, P2_ROUND])
  await db.from('positions').delete().in('account_id', [a, b]).eq('instrument_id', instrumentId)
  await db.from('event_log').delete().in('account_id', [a, b]).in('event_type', ['order_placed', 'order_matched', 'order_rejected'])
  await db.from('event_log').delete().in('event_type', ['round_started', 'round_ended']).in('payload->>roundId', [P1_ROUND, P2_ROUND])
  await db.from('event_log').delete().eq('event_type', 'server_recovered')
  await db.from('rounds').delete().in('id', [P1_ROUND, P2_ROUND])
  await db.from('profiles').update({ realized_pnl: 0 }).in('id', [a, b])
}

async function main(): Promise<void> {
  const A = await resolveId('profiles', 'username', 'team01')
  const B = await resolveId('profiles', 'username', 'team02')
  const aapl = await resolveId('instruments', 'ticker', TICKER)
  await cleanupAll(A, B, aapl)

  // --- Part 0: no-op rehydrate ----------------------------------------------
  console.log('\n0. rehydrate() with nothing to restore:')
  const svc0 = new TradingService(db, controllerFor(P1_ROUND))
  await svc0.loadInstruments()
  const rec0 = await svc0.rehydrate()
  check('no-op (all counts zero)', rec0.roundsRestored === 0 && rec0.ordersRestored === 0 && rec0.accountsWithPnl === 0)
  const recEvt0 = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'server_recovered')
  check('no server_recovered event logged', recEvt0.count === 0, `count=${recEvt0.count}`)

  // --- Part 1: reservation blocks collective over-commit --------------------
  console.log('\n1. Open-order margin reservation (~$12,048 buying power):')
  const svc = new TradingService(db, controllerFor(P1_ROUND))
  await svc.loadInstruments()
  await svc.startRound(0)

  // Order 1: 500 @ 100, 5x → reserves $10,000 (rests, no counterparty).
  const o1 = await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 500, leverage: 5 })
  check('first resting order accepted', o1.accepted)
  check('reserves ~$10,000', near(svc.getReservedMarginInr(A), 10000 * USD_INR, 5), `₹${svc.getReservedMarginInr(A).toFixed(0)}`)

  // Order 2: 200 @ 100, 5x → needs $4,000 but only ~$2,048 free → rejected.
  const o2 = await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 200, leverage: 5 })
  check('second order rejected (would over-commit)', !o2.accepted && o2.reason === 'insufficient_margin', o2.reason)

  // Cancel order 1 → releases its reservation.
  await svc.cancelOrder(o1.orderId as string)
  check('reservation released after cancel (~₹0)', near(svc.getReservedMarginInr(A), 0, 1), `₹${svc.getReservedMarginInr(A).toFixed(0)}`)

  // Order 2 again → now fits.
  const o2b = await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 200, leverage: 5 })
  check('second order now accepted after release', o2b.accepted)

  await svc.endRound(1)
  await cleanupAll(A, B, aapl) // reset for Part 2

  // --- Part 2: crash mid-scenario, then rehydrate ---------------------------
  console.log('\n2. Rehydration after a crash:')
  const live = new TradingService(db, controllerFor(P2_ROUND))
  await live.loadInstruments()
  await live.startRound(0)

  // Open: team01 long 100 @ 100 (5x) vs team02 short 100 @ 100 (5x).
  await live.placeOrder({ accountId: B, ticker: TICKER, side: 'sell', type: 'limit', price: 100, qty: 100, leverage: 5 })
  await live.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 100, leverage: 5 })
  // Reduce 40 @ 110 → realizes P&L: team01 +$400, team02 −$400; both now ±60 @ 100.
  await live.placeOrder({ accountId: B, ticker: TICKER, side: 'buy', type: 'limit', price: 110, qty: 40, leverage: 5 })
  await live.placeOrder({ accountId: A, ticker: TICKER, side: 'sell', type: 'limit', price: 110, qty: 40, leverage: 5 })
  // Leave resting orders that reserve margin: team01 buy 50 @ 90 ($900), team02 sell 30 @ 120 ($720).
  await live.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 90, qty: 50, leverage: 5 })
  await live.placeOrder({ accountId: B, ticker: TICKER, side: 'sell', type: 'limit', price: 120, qty: 30, leverage: 5 })

  // Expected buying-power numbers (INR), for comparison after recovery.
  const expReservedA = 900 * USD_INR
  const expReservedB = 720 * USD_INR
  const expRealizedA = 400 * USD_INR
  const expMarginUsedA = 1200 * USD_INR // 60 @ 100, 5x
  const expAvailableA = 1_000_000 + expRealizedA - expMarginUsedA - expReservedA

  // 💥 crash → fresh service, same round config, rehydrate from the DB.
  const recovered = new TradingService(db, controllerFor(P2_ROUND))
  await recovered.loadInstruments()
  const rec = await recovered.rehydrate()

  check('restored 1 round', rec.roundsRestored === 1, `${rec.roundsRestored}`)
  check('restored 2 resting orders', rec.ordersRestored === 2, `${rec.ordersRestored}`)
  check('restored realized P&L for 2 accounts', rec.accountsWithPnl === 2, `${rec.accountsWithPnl}`)

  // Remaining should be duration (600) minus the real elapsed since startRound
  // (a handful of seconds of DB round-trips) — proving it was derived from
  // started_at/duration, not reset to full or zero.
  const remaining = recovered.getRoundRemainingSeconds()
  check('round remaining time restored (600 − elapsed)', remaining !== null && remaining > 540 && remaining < 600, `${remaining?.toFixed(1)}s`)

  const depth = recovered.getDepth(TICKER)
  check('order book: bid 50 @ 90 restored', depth.bids.some((l) => l.price === 90 && l.qty === 50), JSON.stringify(depth.bids))
  check('order book: ask 30 @ 120 restored', depth.asks.some((l) => l.price === 120 && l.qty === 30), JSON.stringify(depth.asks))

  const stA = await recovered.getAccountState(A)
  const stB = await recovered.getAccountState(B)
  check('team01 realized P&L restored (+₹33,200)', near(stA.realizedPnlInr, expRealizedA), `₹${stA.realizedPnlInr.toFixed(0)}`)
  check('team02 realized P&L restored (−₹33,200)', near(stB.realizedPnlInr, -400 * USD_INR), `₹${stB.realizedPnlInr.toFixed(0)}`)
  check('team01 position restored (long 60 @ 100)', stA.positions[0]?.qty === 60 && near(stA.positions[0].avgPrice, 100, 1e-6))
  check('team01 reserved margin restored (₹74,700)', near(stA.marginReservedInr, expReservedA, 5), `₹${stA.marginReservedInr.toFixed(0)}`)
  check('team02 reserved margin restored (₹59,760)', near(stB.marginReservedInr, expReservedB, 5), `₹${stB.marginReservedInr.toFixed(0)}`)
  check('team01 available margin restored', near(stA.availableMarginInr, expAvailableA, 5), `₹${stA.availableMarginInr.toFixed(0)} vs ₹${expAvailableA.toFixed(0)}`)

  // Restored reservation is ENFORCED: an order that only fits if the reservation
  // were ignored must still be rejected. Needs $11,000; free ≈ $10,348.
  const probe = await recovered.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 550, leverage: 5 })
  check('restored reservation is enforced on new orders', !probe.accepted && probe.reason === 'insufficient_margin', probe.reason)

  const recEvt = await db.from('event_log').select('payload, severity, account_id').eq('event_type', 'server_recovered')
  const evt = recEvt.data?.[0]
  check(
    'server_recovered logged (warning, system, with counts)',
    recEvt.data?.length === 1 && evt?.severity === 'warning' && evt?.account_id === null && evt?.payload?.ordersRestored === 2,
    JSON.stringify(evt?.payload),
  )

  await recovered.endRound(1)

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ Recovery smoke test error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
