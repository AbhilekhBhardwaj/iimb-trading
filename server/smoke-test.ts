/**
 * Smoke test proving the engine↔Supabase wiring end-to-end.
 *
 * It drives the TradingService through a full position lifecycle between two
 * real provisioned accounts (team01, team02) on AAPL, and asserts the DATABASE
 * reflects each step: trades recorded, positions recalculated (open → add →
 * reduce → flip), orders' statuses updated, and event_log populated. It also
 * proves the round gate (an order with no active round is rejected).
 *
 * It is idempotent: it wipes its own prior data at the start, then leaves the
 * fresh rows in place for inspection. Run: npx tsx server/smoke-test.ts
 */

import { RoundController } from '@iimb-trading/engine'
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'

const TICKER = 'AAPL'
const ROUND_ID = 'smoke-round'
const EPS = 1e-6

const db = createAdminClient()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  const mark = cond ? '✓' : '✗'
  console.log(`   ${mark} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS
}

async function resolveId(table: 'profiles' | 'instruments', col: string, val: string): Promise<string> {
  const { data, error } = await db.from(table).select('id').eq(col, val).single()
  if (error || !data) throw new Error(`could not resolve ${table}.${col}=${val}: ${error?.message}`)
  return data.id as string
}

async function getPos(accountId: string, instrumentId: string): Promise<{ qty: number; avg: number } | null> {
  const { data } = await db
    .from('positions')
    .select('qty, avg_price')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .maybeSingle()
  return data ? { qty: Number(data.qty), avg: Number(data.avg_price) } : null
}

async function cleanup(a: string, b: string, instrumentId: string): Promise<void> {
  // FK-safe order: trades → orders → rounds; positions/event_log are independent.
  // Scope event_log to the event types THIS test produces — never touch other
  // events (e.g. account_provisioned) for these real accounts.
  await db.from('trades').delete().eq('round_id', ROUND_ID)
  await db.from('orders').delete().eq('round_id', ROUND_ID)
  await db.from('positions').delete().in('account_id', [a, b]).eq('instrument_id', instrumentId)
  await db
    .from('event_log')
    .delete()
    .in('account_id', [a, b])
    .in('event_type', ['order_placed', 'order_matched', 'order_rejected'])
  await db.from('event_log').delete().in('event_type', ['round_started', 'round_ended']).eq('payload->>roundId', ROUND_ID)
  await db.from('rounds').delete().eq('id', ROUND_ID)
  await db.from('profiles').update({ realized_pnl: 0 }).in('id', [a, b])
}

async function main(): Promise<void> {
  const A = await resolveId('profiles', 'username', 'team01')
  const B = await resolveId('profiles', 'username', 'team02')
  const aapl = await resolveId('instruments', 'ticker', TICKER)

  console.log(`\nSmoke test: team01=${A.slice(0, 8)}… team02=${B.slice(0, 8)}… ${TICKER}=${aapl.slice(0, 8)}…\n`)
  await cleanup(A, B, aapl)

  const rounds = new RoundController([
    { id: ROUND_ID, mode: 'only_data', durationSeconds: 600, commissionEnabled: false },
  ])
  const svc = new TradingService(db, rounds)
  await svc.loadInstruments()

  // --- Round gate -----------------------------------------------------------
  console.log('1. Round gate (no active round):')
  const rejected = await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 10 })
  check('order rejected when no round active', !rejected.accepted, rejected.reason)

  await svc.startRound(0)

  // --- Lifecycle: open → add → reduce → flip --------------------------------
  // B provides resting liquidity; A takes. Prices chosen for clean averages.
  console.log('\n2. Open (A buys 50 @ 100):')
  await svc.placeOrder({ accountId: B, ticker: TICKER, side: 'sell', type: 'limit', price: 100, qty: 50 })
  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 100, qty: 50 })
  let pa = await getPos(A, aapl)
  let pb = await getPos(B, aapl)
  check('A long 50 @ 100', !!pa && pa.qty === 50 && approx(pa.avg, 100), `${pa?.qty} @ ${pa?.avg}`)
  check('B short 50 @ 100', !!pb && pb.qty === -50 && approx(pb.avg, 100), `${pb?.qty} @ ${pb?.avg}`)

  console.log('\n3. Add (A buys 50 @ 110 → weighted avg 105):')
  await svc.placeOrder({ accountId: B, ticker: TICKER, side: 'sell', type: 'limit', price: 110, qty: 50 })
  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'buy', type: 'limit', price: 110, qty: 50 })
  pa = await getPos(A, aapl)
  pb = await getPos(B, aapl)
  check('A long 100 @ 105 (add)', !!pa && pa.qty === 100 && approx(pa.avg, 105), `${pa?.qty} @ ${pa?.avg}`)
  check('B short 100 @ 105 (add)', !!pb && pb.qty === -100 && approx(pb.avg, 105), `${pb?.qty} @ ${pb?.avg}`)

  console.log('\n4. Reduce (A sells 60 @ 120 → avg unchanged 105):')
  await svc.placeOrder({ accountId: B, ticker: TICKER, side: 'buy', type: 'limit', price: 120, qty: 60 })
  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'sell', type: 'limit', price: 120, qty: 60 })
  pa = await getPos(A, aapl)
  pb = await getPos(B, aapl)
  check('A long 40 @ 105 (reduce, avg held)', !!pa && pa.qty === 40 && approx(pa.avg, 105), `${pa?.qty} @ ${pa?.avg}`)
  check('B short 40 @ 105 (reduce, avg held)', !!pb && pb.qty === -40 && approx(pb.avg, 105), `${pb?.qty} @ ${pb?.avg}`)

  console.log('\n5. Flip (A sells 100 @ 130 → net short 60 @ 130):')
  await svc.placeOrder({ accountId: B, ticker: TICKER, side: 'buy', type: 'limit', price: 130, qty: 100 })
  await svc.placeOrder({ accountId: A, ticker: TICKER, side: 'sell', type: 'limit', price: 130, qty: 100 })
  pa = await getPos(A, aapl)
  pb = await getPos(B, aapl)
  check('A short 60 @ 130 (flip)', !!pa && pa.qty === -60 && approx(pa.avg, 130), `${pa?.qty} @ ${pa?.avg}`)
  check('B long 60 @ 130 (flip)', !!pb && pb.qty === 60 && approx(pb.avg, 130), `${pb?.qty} @ ${pb?.avg}`)

  await svc.endRound(1)

  // --- DB-side tallies ------------------------------------------------------
  console.log('\n6. Database tallies:')
  const trades = await db.from('trades').select('id', { count: 'exact', head: true }).eq('round_id', ROUND_ID)
  check('4 trades recorded', trades.count === 4, `count=${trades.count}`)

  const orders = await db.from('orders').select('status', { count: 'exact' }).eq('round_id', ROUND_ID)
  const filled = (orders.data ?? []).filter((o) => o.status === 'filled').length
  check('8 orders written', orders.count === 8, `count=${orders.count}`)
  check('all 8 orders filled', filled === 8, `filled=${filled}`)

  const placed = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'order_placed').in('account_id', [A, B])
  const matched = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'order_matched').in('account_id', [A, B])
  const rej = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'order_rejected').in('account_id', [A, B])
  const started = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'round_started').eq('payload->>roundId', ROUND_ID)
  const ended = await db.from('event_log').select('id', { count: 'exact', head: true }).eq('event_type', 'round_ended').eq('payload->>roundId', ROUND_ID)
  check('8 order_placed events', placed.count === 8, `count=${placed.count}`)
  check('8 order_matched events (2 per trade)', matched.count === 8, `count=${matched.count}`)
  check('1 order_rejected event (warning)', rej.count === 1, `count=${rej.count}`)
  check('round_started + round_ended logged', started.count === 1 && ended.count === 1, `${started.count}/${ended.count}`)

  const roundRow = await db.from('rounds').select('status, started_at, ended_at').eq('id', ROUND_ID).single()
  check(
    'round row ended with timestamps',
    roundRow.data?.status === 'ended' && !!roundRow.data?.started_at && !!roundRow.data?.ended_at,
    JSON.stringify(roundRow.data),
  )

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ Smoke test error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
