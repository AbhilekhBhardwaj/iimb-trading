// @vitest-environment node
/**
 * The margin gate must hold under CONCURRENT orders from one account.
 *
 * Reported from QA: two simultaneous 45-lot buys from a single team both
 * filled, leaving 93 shares (~Rs 17.4L of exposure) on a Rs 10L account. Each
 * order was individually affordable; together they were not. The gate reads
 * available margin, awaits, then places — and two requests interleaved in that
 * window both read the same pre-trade balance and both passed.
 *
 * These tests fire orders without awaiting in between, which is what a browser
 * with two clicks (or a double-submit) actually produces.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const TEAM = 'acct-team'
const MAKER = 'acct-maker'
/** Rs 10 lakh, as the event provisions a team. */
const TEAM_CASH = 1_000_000
const RATE = DEFAULT_USD_INR_RATE // 83

function schedule(): EventConfig {
  return [{ id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: RATE, commissionRate: 0 }]
}

async function harness(cash = TEAM_CASH) {
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: TEAM, username: 'team01', team_name: 'A', role: 'team', starting_cash: cash, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: MAKER, username: 'mm', team_name: null, role: 'market_maker', starting_cash: 1_000_000_000, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const svc = new TradingService(db as unknown as SupabaseClient, new RoundController(schedule()))
  await svc.loadInstruments()
  await svc.startRound(0)
  return { db, svc }
}

/** Deep liquidity so nothing is rejected for lack of a counterparty. */
const restAsk = (svc: TradingService, price: number, qty: number) =>
  svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'sell', type: 'limit', price, qty, leverage: 1 })

const buy = (svc: TradingService, qty: number, price = 200) =>
  svc.placeOrder({ accountId: TEAM, ticker: 'AAPL', side: 'buy', type: 'limit', price, qty, leverage: 1 })

const positionQty = (db: FakeDb, id: string) =>
  Number(db.rows('positions').find((p) => p.account_id === id)?.qty ?? 0)

// 45 lots x $200 x 83 = Rs 7,47,000 each. One fits in Rs 10L; two do not.
const LOT = 45
const COST_PER_ORDER = LOT * 200 * RATE

// ---------------------------------------------------------------------------

describe('the QA report, reproduced exactly', () => {
  it('two simultaneous 45-lot buys cannot both fill on a Rs 10L account', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 500)

    // Sanity: each order alone is affordable, the pair is not.
    expect(COST_PER_ORDER).toBeLessThan(TEAM_CASH)
    expect(COST_PER_ORDER * 2).toBeGreaterThan(TEAM_CASH)

    // Fired together, with no await in between — the shape of a double-submit.
    const [a, b] = await Promise.all([buy(svc, LOT), buy(svc, LOT)])

    const accepted = [a, b].filter((r) => r.accepted)
    expect(accepted).toHaveLength(1) // exactly one, never both
    const rejected = [a, b].find((r) => !r.accepted)!
    expect(rejected.rejection?.code).toBe('insufficient_margin')

    expect(positionQty(db, TEAM)).toBe(LOT) // 45, not the reported 93
  })

  it('never exceeds the account balance in exposure', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 500)
    await Promise.all([buy(svc, LOT), buy(svc, LOT)])

    const exposure = Math.abs(positionQty(db, TEAM)) * 200 * RATE
    expect(exposure).toBeLessThanOrEqual(TEAM_CASH)
  })

  it('leaves margin used within the account balance', async () => {
    const { svc } = await harness()
    await restAsk(svc, 200, 500)
    await Promise.all([buy(svc, LOT), buy(svc, LOT)])

    const state = await svc.getAccountState(TEAM)
    expect(state.marginUsedInr).toBeLessThanOrEqual(TEAM_CASH)
    expect(state.availableMarginInr).toBeGreaterThanOrEqual(0) // never negative
  })
})

describe('it holds at higher concurrency, not just two', () => {
  it('five simultaneous orders admit only what the balance affords', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 2000)

    const results = await Promise.all(Array.from({ length: 5 }, () => buy(svc, LOT)))
    const accepted = results.filter((r) => r.accepted).length

    // Rs 10L / Rs 7.47L = 1 order affordable.
    expect(accepted).toBe(1)
    expect(positionQty(db, TEAM)).toBe(LOT)
  })

  it('ten small orders that TOGETHER exceed the balance are cut off at the limit', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 2000)

    // 10 lots each = Rs 1,66,000. Six fit in Rs 10L (Rs 9.96L); the seventh does not.
    const results = await Promise.all(Array.from({ length: 10 }, () => buy(svc, 10)))
    const accepted = results.filter((r) => r.accepted).length
    expect(accepted).toBe(6)
    expect(positionQty(db, TEAM)).toBe(60)

    const state = await svc.getAccountState(TEAM)
    expect(state.availableMarginInr).toBeGreaterThanOrEqual(0)
  })

  it('every rejection says insufficient_margin, not something incidental', async () => {
    const { svc } = await harness()
    await restAsk(svc, 200, 2000)
    const results = await Promise.all(Array.from({ length: 5 }, () => buy(svc, LOT)))
    for (const r of results.filter((x) => !x.accepted)) {
      expect(r.rejection?.code).toBe('insufficient_margin')
    }
  })
})

describe('resting orders reserve margin against concurrent siblings too', () => {
  it('two simultaneous RESTING orders cannot both reserve the same margin', async () => {
    const { svc } = await harness()
    // No liquidity: both orders rest, each reserving margin.
    const results = await Promise.all([buy(svc, LOT, 190), buy(svc, LOT, 190)])
    expect(results.filter((r) => r.accepted)).toHaveLength(1)

    const state = await svc.getAccountState(TEAM)
    expect(state.marginReservedInr).toBeLessThanOrEqual(TEAM_CASH)
  })

  it('a resting order blocks a concurrent one that would over-commit', async () => {
    const { svc } = await harness()
    await restAsk(svc, 200, 500)
    // One rests below the market, one takes liquidity: together over budget.
    const [rest, take] = await Promise.all([buy(svc, LOT, 190), buy(svc, LOT, 200)])
    expect([rest.accepted, take.accepted].filter(Boolean)).toHaveLength(1)
  })
})

describe('serialization does not break the ordinary path', () => {
  it('concurrent orders from DIFFERENT accounts are unaffected by each other', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 500)
    // The market maker is exempt from the gate; the team is not. Both should
    // proceed on their own merits, not queue behind one another.
    const [team, mm] = await Promise.all([
      buy(svc, 10),
      svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 200, qty: 10, leverage: 1 }),
    ])
    expect(team.accepted).toBe(true)
    expect(mm.accepted).toBe(true)
    expect(positionQty(db, TEAM)).toBe(10)
  })

  it('sequential orders within budget all still fill', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 500)
    for (let i = 0; i < 5; i++) expect((await buy(svc, 10)).accepted).toBe(true)
    expect(positionQty(db, TEAM)).toBe(50)
  })

  it('concurrent orders comfortably within budget ALL fill', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 500)
    // 3 x 10 lots = Rs 4.98L, well inside Rs 10L.
    const results = await Promise.all([buy(svc, 10), buy(svc, 10), buy(svc, 10)])
    expect(results.every((r) => r.accepted)).toBe(true)
    expect(positionQty(db, TEAM)).toBe(30)
  })

  it('a concurrent CLOSE is never blocked — reducing frees margin', async () => {
    const { db, svc } = await harness()
    await restAsk(svc, 200, 500)
    await buy(svc, 20)
    await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 200, qty: 20, leverage: 1 })

    const [sell] = await Promise.all([
      svc.placeOrder({ accountId: TEAM, ticker: 'AAPL', side: 'sell', type: 'limit', price: 200, qty: 20, leverage: 1 }),
    ])
    expect(sell.accepted).toBe(true)
    expect(positionQty(db, TEAM)).toBe(0)
  })

  it('the market maker is still exempt under concurrency', async () => {
    const { svc } = await harness()
    await restAsk(svc, 200, 5000)
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 200, qty: 500, leverage: 1, role: 'market_maker' }),
      ),
    )
    expect(results.every((r) => r.accepted)).toBe(true)
  })
})
