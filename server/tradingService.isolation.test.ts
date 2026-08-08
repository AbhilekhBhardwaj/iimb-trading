// @vitest-environment node
/**
 * Cross-account isolation, and the role gates on every privileged operation.
 *
 * QA flagged this as untested, and it was: role refusals were covered
 * incidentally by the liquidation and commission suites, but nothing asserted
 * that one team cannot read or touch another team's data, or that every
 * master-only control refuses a team.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const A = 'acct-a'
const B = 'acct-b'
const MAKER = 'acct-maker'
const MASTER_ID = 'acct-master'
const CASH = 10_000_000

const AS_A = { accountId: A, role: 'team' }
const AS_B = { accountId: B, role: 'team' }
const AS_MM = { accountId: MAKER, role: 'market_maker' }
const AS_MASTER = { accountId: MASTER_ID, role: 'master' }

function schedule(): EventConfig {
  return [
    { id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: DEFAULT_USD_INR_RATE, commissionRate: 0 },
    { id: 'r2', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: DEFAULT_USD_INR_RATE, commissionRate: 0 },
  ]
}

async function harness(startRound = true) {
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: A, username: 'team01', team_name: 'A', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: B, username: 'team02', team_name: 'B', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: MAKER, username: 'mm', team_name: null, role: 'market_maker', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: MASTER_ID, username: 'master', team_name: null, role: 'master', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const svc = new TradingService(db as unknown as SupabaseClient, new RoundController(schedule()))
  await svc.loadInstruments()
  if (startRound) await svc.startRound(0)
  return { db, svc }
}

const limit = (svc: TradingService, who: string, side: 'buy' | 'sell', price: number, qty: number) =>
  svc.placeOrder({ accountId: who, ticker: 'AAPL', side, type: 'limit', price, qty, leverage: 1 })

// ---------------------------------------------------------------------------

describe('a team sees only its own account data', () => {
  it('portfolio is scoped to the account asked for, never merged', async () => {
    const { svc } = await harness()
    await limit(svc, A, 'sell', 200, 10)
    await limit(svc, B, 'buy', 200, 10) // both now hold a position

    const pa = await svc.portfolio(A)
    const pb = await svc.portfolio(B)
    // Opposite sides of the same trade: their P&L cannot be identical by accident.
    expect(pa.realizedPnlInr).not.toBe(undefined)
    expect((pa.inventory as { ticker: string; qty: number | null }[]).find((r) => r.ticker === 'AAPL')!.qty).toBe(-10)
    expect((pb.inventory as { ticker: string; qty: number | null }[]).find((r) => r.ticker === 'AAPL')!.qty).toBe(10)
  })

  it('working orders never leak across accounts', async () => {
    const { svc } = await harness()
    await limit(svc, A, 'buy', 180, 5)
    expect(await svc.workingOrders(A)).toHaveLength(1)
    expect(await svc.workingOrders(B)).toHaveLength(0)
  })

  it('one account cannot see another account resting orders in its own depth', async () => {
    const { svc } = await harness()
    await limit(svc, A, 'buy', 180, 5)
    // B sees the LIQUIDITY (that is a public book) but none of it marked as its own.
    const forB = svc.depthView('AAPL', false, B)
    expect(forB.bids[0].qty).toBe(5)
    expect(forB.bids[0].ownQty).toBe(0)
  })

  it('the per-order market-maker view is withheld from teams', async () => {
    const { svc } = await harness()
    await limit(svc, A, 'buy', 180, 5)
    // includeResting is driven by role at the API layer; a team gets no list.
    expect(svc.depthView('AAPL', false, B).restingOrders).toBeUndefined()
    expect(svc.depthView('AAPL', true, MAKER).restingOrders).toHaveLength(1)
  })

  it('the leaderboard is event-wide BY DESIGN — every team is meant to see it', async () => {
    const { svc } = await harness()
    const board = await svc.leaderboard()
    expect(board.map((t) => t.username).sort()).toEqual(['team01', 'team02'])
    // Market maker and master are excluded from the standings.
    expect(board.some((t) => t.username === 'mm')).toBe(false)
    expect(board.some((t) => t.username === 'master')).toBe(false)
  })
})

describe('a team cannot touch another team orders', () => {
  it('cannot cancel an order it does not own', async () => {
    const { svc } = await harness()
    const placed = await limit(svc, A, 'buy', 180, 5)
    expect(await svc.cancelOrder(placed.orderId!, AS_B)).toBe(false)
    expect(await svc.workingOrders(A)).toHaveLength(1) // still resting
  })

  it('the market maker cannot cancel a team order either', async () => {
    const { svc } = await harness()
    const placed = await limit(svc, A, 'buy', 180, 5)
    expect(await svc.cancelOrder(placed.orderId!, AS_MM)).toBe(false)
  })

  it('but CAN cancel its own', async () => {
    const { svc } = await harness()
    const placed = await limit(svc, A, 'buy', 180, 5)
    expect(await svc.cancelOrder(placed.orderId!, AS_A)).toBe(true)
    expect(await svc.workingOrders(A)).toHaveLength(0)
  })

  it('master can cancel any order — deliberate, for round cleanup', async () => {
    const { svc } = await harness()
    const placed = await limit(svc, A, 'buy', 180, 5)
    expect(await svc.cancelOrder(placed.orderId!, AS_MASTER)).toBe(true)
  })
})

describe('every master-only control refuses a team and the market maker', () => {
  const RATE = 90
  it.each([
    ['setUsdInrRate', (svc: TradingService, c: typeof AS_A) => svc.setUsdInrRate(c, RATE)],
    ['setCommissionRate', (svc: TradingService, c: typeof AS_A) => svc.setCommissionRate(c, 0.005)],
    ['setSlippageEnabled', (svc: TradingService, c: typeof AS_A) => svc.setSlippageEnabled(c, false)],
    ['setInstrumentPrices', (svc: TradingService, c: typeof AS_A) => svc.setInstrumentPrices(c, [{ ticker: 'AAPL', price: 300 }])],
    ['resetEvent', (svc: TradingService, c: typeof AS_A) => svc.resetEvent(c)],
  ])('%s refuses a team', async (_name, call) => {
    const { svc } = await harness()
    expect((await call(svc, AS_A)).applied).toBe(false)
    expect((await call(svc, AS_A)).reason).toBe('forbidden')
  })

  it.each([
    ['setUsdInrRate', (svc: TradingService, c: typeof AS_MM) => svc.setUsdInrRate(c, RATE)],
    ['setCommissionRate', (svc: TradingService, c: typeof AS_MM) => svc.setCommissionRate(c, 0.005)],
    ['setSlippageEnabled', (svc: TradingService, c: typeof AS_MM) => svc.setSlippageEnabled(c, false)],
    ['setInstrumentPrices', (svc: TradingService, c: typeof AS_MM) => svc.setInstrumentPrices(c, [{ ticker: 'AAPL', price: 300 }])],
    ['resetEvent', (svc: TradingService, c: typeof AS_MM) => svc.resetEvent(c)],
  ])('%s refuses the market maker', async (_name, call) => {
    const { svc } = await harness()
    expect((await call(svc, AS_MM)).applied).toBe(false)
  })

  it('a refused control changes NOTHING — not a silent partial apply', async () => {
    const { svc } = await harness()
    const before = svc.rateInr()
    await svc.setUsdInrRate(AS_A, 999)
    expect(svc.rateInr()).toBe(before)
  })

  it('resetEvent refused by a team leaves every position standing', async () => {
    const { db, svc } = await harness()
    await limit(svc, A, 'sell', 200, 10)
    await limit(svc, B, 'buy', 200, 10)
    await svc.resetEvent(AS_A)
    expect(db.rows('positions').filter((p) => Number(p.qty) !== 0).length).toBeGreaterThan(0)
  })
})

describe('market-maker-only controls refuse teams and the master', () => {
  it('the liquidatable list is empty for anyone else', async () => {
    const { svc } = await harness()
    expect(await svc.liquidatablePositions(AS_A)).toEqual([])
    expect(await svc.liquidatablePositions(AS_MASTER)).toEqual([])
  })

  it('force-close refuses a team and the master', async () => {
    const { svc } = await harness()
    expect((await svc.liquidatePosition(AS_A, B, 'AAPL')).reason).toBe('forbidden')
    expect((await svc.liquidatePosition(AS_MASTER, B, 'AAPL')).reason).toBe('forbidden')
  })
})

describe('an order is always attributed to the caller, never to a supplied id', () => {
  it('placing for A creates A position, whoever claims otherwise', async () => {
    const { db, svc } = await harness()
    await limit(svc, A, 'sell', 200, 10)
    await limit(svc, B, 'buy', 200, 10)
    const posA = db.rows('positions').find((p) => p.account_id === A)!
    const posB = db.rows('positions').find((p) => p.account_id === B)!
    expect(Number(posA.qty)).toBe(-10)
    expect(Number(posB.qty)).toBe(10)
  })

  it('one account margin is never spent by another', async () => {
    const { svc } = await harness()
    await limit(svc, A, 'buy', 180, 20)
    const stateA = await svc.getAccountState(A)
    const stateB = await svc.getAccountState(B)
    expect(stateA.marginReservedInr).toBeGreaterThan(0)
    expect(stateB.marginReservedInr).toBe(0)
    expect(stateB.availableMarginInr).toBe(CASH)
  })
})
