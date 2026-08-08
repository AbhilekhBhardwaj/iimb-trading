// @vitest-environment node
/**
 * Commission, end to end.
 *
 * Five claims, each verified against the real TradingService rather than
 * asserted: the rate is forward-only across a mid-round change; commission is
 * charged on every fill regardless of the display toggle; the arithmetic is
 * right at several rates; the Portfolio total sums correctly across fills that
 * settled at DIFFERENT rates; and the confirm popup prices at the rate in force.
 */
import { describe, expect, it } from 'vitest'
import {
  commissionInrFor,
  DEFAULT_COMMISSION_RATE,
  DEFAULT_USD_INR_RATE,
  type EventConfig,
  RoundController,
} from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const A = 'acct-a'
const B = 'acct-b'
const MASTER = { accountId: 'acct-master', role: 'master' }
const CASH = 100_000_000
const RATE = DEFAULT_USD_INR_RATE // 83

/** `commissionEnabled` is the DISPLAY toggle only; `commissionRate` charges. */
function schedule(rate: number, enabled: boolean): EventConfig {
  return [
    { id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: enabled, usdInrRate: RATE, commissionRate: rate },
  ]
}

async function harness(rate = 0.003, enabled = true) {
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: A, username: 'team01', team_name: 'A', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: B, username: 'team02', team_name: 'B', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: MASTER.accountId, username: 'master', team_name: null, role: 'master', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const svc = new TradingService(db as unknown as SupabaseClient, new RoundController(schedule(rate, enabled)))
  await svc.loadInstruments()
  await svc.startRound(0)
  return { db, svc }
}

/** Cross a buy and a sell at `price` so both sides fill for `qty`. */
async function cross(svc: TradingService, qty: number, price: number) {
  await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'sell', type: 'limit', price, qty, leverage: 1 })
  return svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'limit', price, qty, leverage: 1 })
}

const trades = (db: FakeDb) => db.rows('trades')
const commissionLogs = (db: FakeDb) =>
  db.rows('event_log').filter((e) => e.event_type === 'commission_charged')

// ---------------------------------------------------------------------------
// 1. Forward-only: a mid-round change never rewrites a settled fill
// ---------------------------------------------------------------------------

describe('1. a mid-round rate change is FORWARD-ONLY', () => {
  it('stamps each trade with the rate in force when it settled', async () => {
    const { db, svc } = await harness(0.003)
    await cross(svc, 10, 200) // settles at 0.3%

    const changed = await svc.setCommissionRate(MASTER, 0.005)
    expect(changed.applied).toBe(true)

    await cross(svc, 10, 200) // settles at 0.5%

    const rows = trades(db)
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].commission_rate)).toBe(0.003) // untouched by the change
    expect(Number(rows[1].commission_rate)).toBe(0.005)
  })

  it('the earlier fill is charged at the OLD rate, in rupees', async () => {
    const { db, svc } = await harness(0.003)
    await cross(svc, 10, 200)
    await svc.setCommissionRate(MASTER, 0.005)
    await cross(svc, 10, 200)

    // 10 x $200 x 83 = 166,000 notional per fill.
    const [first, second] = commissionLogs(db).filter((e) => e.account_id === A)
    expect(Number(first.payload.commissionInr)).toBeCloseTo(166_000 * 0.003, 6) // 498
    expect(Number(second.payload.commissionInr)).toBeCloseTo(166_000 * 0.005, 6) // 830
  })

  it('raising the rate does not retroactively deepen an earlier charge', async () => {
    const { db, svc } = await harness(0.003)
    await cross(svc, 10, 200)
    const afterFirst = Number(db.profile(A)!.realized_pnl_inr)
    expect(afterFirst).toBeCloseTo(-498, 6)

    await svc.setCommissionRate(MASTER, 0.01) // more than tripled
    // No new fill: the settled charge must not move.
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(afterFirst, 6)
  })

  it('lowering the rate does not refund an earlier charge either', async () => {
    const { db, svc } = await harness(0.01)
    await cross(svc, 10, 200)
    const afterFirst = Number(db.profile(A)!.realized_pnl_inr)
    await svc.setCommissionRate(MASTER, 0.001)
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(afterFirst, 6)
  })

  it('only the master can change it', async () => {
    const { svc } = await harness(0.003)
    expect((await svc.setCommissionRate({ accountId: A, role: 'team' }, 0.005)).reason).toBe('forbidden')
    expect((await svc.setCommissionRate({ accountId: A, role: 'market_maker' }, 0.005)).reason).toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// 2. The toggle is display-only
// ---------------------------------------------------------------------------

describe('2. commission is ALWAYS charged, whatever the toggle says', () => {
  it('charges with the toggle OFF', async () => {
    const { db, svc } = await harness(0.003, false)
    await cross(svc, 10, 200)
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(-498, 6)
    expect(commissionLogs(db).length).toBeGreaterThan(0)
  })

  it('charges the identical amount with the toggle ON', async () => {
    const off = await harness(0.003, false)
    await cross(off.svc, 10, 200)
    const on = await harness(0.003, true)
    await cross(on.svc, 10, 200)

    expect(Number(off.db.profile(A)!.realized_pnl_inr))
      .toBeCloseTo(Number(on.db.profile(A)!.realized_pnl_inr), 6)
  })

  it('charges BOTH sides of the fill, not just the aggressor', async () => {
    const { db, svc } = await harness(0.003, false)
    await cross(svc, 10, 200)
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(-498, 6)
    expect(Number(db.profile(B)!.realized_pnl_inr)).toBeCloseTo(-498, 6)
  })

  it('charges on an OPENING fill, which realizes nothing', async () => {
    const { db, svc } = await harness(0.003, false)
    await cross(svc, 10, 200) // pure open for both sides
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeLessThan(0) // charged anyway
  })

  it('a rate of 0 is the only way to charge nothing', async () => {
    const { db, svc } = await harness(0, true)
    await cross(svc, 10, 200)
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. The arithmetic, at several rates
// ---------------------------------------------------------------------------

describe('3. the charged amount is correct at every rate', () => {
  // 10 units x $200 x 83 = 166,000 INR of notional per fill.
  const NOTIONAL = 10 * 200 * RATE

  it.each([
    [0.001, 166], // 0.1%
    [0.003, 498], // 0.3%
    [0.005, 830], // 0.5%
    [0.01, 1660], // 1%
  ])('rate %s charges the expected rupees', async (rate, expected) => {
    const { db, svc } = await harness(rate)
    await cross(svc, 10, 200)
    expect(NOTIONAL * rate).toBeCloseTo(expected, 6) // the arithmetic itself
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(-expected, 6)
  })

  it('0.3% of 10 x $200 at 83: 166,000 x 0.003 = 498', async () => {
    const { db, svc } = await harness(0.003)
    await cross(svc, 10, 200)
    const charged = Number(commissionLogs(db).find((e) => e.account_id === A)!.payload.commissionInr)
    expect(charged).toBe(498)
    expect(commissionInrFor(10, 200, RATE, 0.003)).toBe(498) // the engine agrees
  })

  it('0.5% of 7 x $226 at 95: 150,290 x 0.005 = 751.45', () => {
    // Real numbers from the event log, at the rate the Master had pinned.
    expect(7 * 226 * 95).toBe(150_290)
    expect(commissionInrFor(7, 226, 95, 0.005)).toBeCloseTo(751.45, 6)
  })

  it('scales linearly with quantity and with price', async () => {
    const one = await harness(0.003)
    await cross(one.svc, 10, 200)
    const two = await harness(0.003)
    await cross(two.svc, 20, 200)
    expect(Number(two.db.profile(A)!.realized_pnl_inr))
      .toBeCloseTo(Number(one.db.profile(A)!.realized_pnl_inr) * 2, 6)
  })

  it('uses the FILL rate, so a USD/INR change moves it too', () => {
    expect(commissionInrFor(10, 200, 83, 0.003)).toBe(498)
    expect(commissionInrFor(10, 200, 95, 0.003)).toBeCloseTo(570, 6)
  })

  it('an invalid rate falls back to the default rather than charging nonsense', () => {
    expect(commissionInrFor(10, 200, RATE, Number.NaN))
      .toBeCloseTo(commissionInrFor(10, 200, RATE, DEFAULT_COMMISSION_RATE), 6)
    expect(commissionInrFor(10, 200, RATE, -1))
      .toBeCloseTo(commissionInrFor(10, 200, RATE, DEFAULT_COMMISSION_RATE), 6)
  })
})

// ---------------------------------------------------------------------------
// 4. The Portfolio total, across a mid-event rate change
// ---------------------------------------------------------------------------

describe('4. Commission Charged sums correctly across MIXED rates', () => {
  it('adds fills settled at different rates, each at its own rate', async () => {
    const { svc } = await harness(0.003)
    await cross(svc, 10, 200) // 498 at 0.3%
    await svc.setCommissionRate(MASTER, 0.005)
    await cross(svc, 10, 200) // 830 at 0.5%

    const charges = (await svc.portfolio(A)).chargesInr as number
    expect(charges).toBeCloseTo(498 + 830, 6) // 1,328 — NOT 2 x either rate
  })

  it('is not the naive "all fills at the CURRENT rate" figure', async () => {
    const { svc } = await harness(0.003)
    await cross(svc, 10, 200)
    await svc.setCommissionRate(MASTER, 0.005)
    await cross(svc, 10, 200)

    const charges = (await svc.portfolio(A)).chargesInr as number
    expect(charges).not.toBeCloseTo(830 * 2, 6) // would be 1,660 if it re-priced
    expect(charges).not.toBeCloseTo(498 * 2, 6) // or 996 if it used the old one
  })

  it('handles three different rates in one event', async () => {
    const { svc } = await harness(0.001)
    await cross(svc, 10, 200) // 166
    await svc.setCommissionRate(MASTER, 0.005)
    await cross(svc, 10, 200) // 830
    await svc.setCommissionRate(MASTER, 0.01)
    await cross(svc, 10, 200) // 1,660

    expect((await svc.portfolio(A)).chargesInr as number).toBeCloseTo(166 + 830 + 1660, 6)
  })

  it('matches the sum of what was actually deducted from realized P&L', async () => {
    // Pure opens realize nothing, so realized P&L IS the commission taken.
    const { db, svc } = await harness(0.003)
    await cross(svc, 10, 200)
    await svc.setCommissionRate(MASTER, 0.005)
    await cross(svc, 5, 200)

    const charges = (await svc.portfolio(A)).chargesInr as number
    expect(charges).toBeCloseTo(-Number(db.profile(A)!.realized_pnl_inr), 6)
  })

  it('counts opening fills, which never appear in Trade History', async () => {
    const { svc } = await harness(0.003)
    await cross(svc, 10, 200) // open only
    const p = await svc.portfolio(A)
    expect(p.chargesInr as number).toBeCloseTo(498, 6)
    expect(p.tradeHistory as unknown[]).toHaveLength(0) // nothing realized yet
  })
})

// ---------------------------------------------------------------------------
// 5. The rate the confirm popup prices at
// ---------------------------------------------------------------------------

describe('5. the popup is fed the rate currently in force', () => {
  it('the portfolio payload reports the new rate immediately after a change', async () => {
    const { svc } = await harness(0.003)
    expect((await svc.portfolio(A)).commissionRate).toBe(0.003)
    await svc.setCommissionRate(MASTER, 0.005)
    expect((await svc.portfolio(A)).commissionRate).toBe(0.005)
  })

  it('the snapshot round reports it too — the Terminal popup reads this', async () => {
    const { svc } = await harness(0.003)
    await svc.setCommissionRate(MASTER, 0.005)
    const snap = await svc.snapshot(A, 'team', 'AAPL')
    expect((snap.round as { commissionRate: number }).commissionRate).toBe(0.005)
  })

  it('never a stale default: a round configured at 1% reports 1%', async () => {
    const { svc } = await harness(0.01)
    expect((await svc.portfolio(A)).commissionRate).toBe(0.01)
    expect((await svc.portfolio(A)).commissionRate).not.toBe(DEFAULT_COMMISSION_RATE)
  })

  it('the estimate the popup shows matches what the fill actually charges', async () => {
    const { db, svc } = await harness(0.005)
    // What the popup would compute from the payload it is given:
    const quoted = commissionInrFor(10, 200, (await svc.portfolio(A)).rate as number, (await svc.portfolio(A)).commissionRate as number)
    await cross(svc, 10, 200)
    const actual = Number(commissionLogs(db).find((e) => e.account_id === A)!.payload.commissionInr)
    expect(quoted).toBeCloseTo(actual, 6)
  })

  it('and still matches after a mid-round change', async () => {
    const { db, svc } = await harness(0.003)
    await svc.setCommissionRate(MASTER, 0.01)
    const p = await svc.portfolio(A)
    const quoted = commissionInrFor(10, 200, p.rate as number, p.commissionRate as number)
    await cross(svc, 10, 200)
    const actual = Number(commissionLogs(db).find((e) => e.account_id === A)!.payload.commissionInr)
    expect(quoted).toBeCloseTo(actual, 6)
    expect(quoted).toBeCloseTo(1660, 6)
  })
})


describe('the snapshot names the instrument it is FOR', () => {
  it('carries the ticker, so the chart can reject a stale payload', async () => {
    const { svc } = await harness()
    const snap = await svc.snapshot(A, 'team', 'AAPL')
    expect(snap.ticker).toBe('AAPL')
  })

  it('is null when no instrument is selected', async () => {
    const { svc } = await harness()
    expect((await svc.snapshot(A, 'team', null)).ticker).toBeNull()
  })

  it('always matches the per-ticker fields in the same payload', async () => {
    const { svc } = await harness()
    await cross(svc, 10, 200)
    const snap = await svc.snapshot(A, 'team', 'AAPL')
    expect(snap.ticker).toBe('AAPL')
    expect(snap.depth).not.toBeNull()
    expect(Array.isArray(snap.prices)).toBe(true)
  })
})
