// @vitest-environment node
/**
 * Auto-liquidation enforcement.
 *
 * liquidationPrice was computed and displayed everywhere and enforced nowhere:
 * a position could pass the price at which its margin is exhausted and simply
 * stay open. Under the 1x-only model this is a SHORT problem specifically — a
 * long liquidates at E*(1 - 1/1) = 0, unreachable unless the stock hits zero,
 * but a short liquidates at E*(1 + 1/1), the moment the price doubles.
 *
 * These tests drive the real TradingService: a real book, real fills, real
 * settlement. Nothing is stubbed except the database.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, liquidationPrice, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 100 }
const SHORTER = 'acct-short' // opens the short that will be liquidated
const MAKER = 'acct-maker' // provides the liquidity it closes against
const OTHER = 'acct-other' // trades with MAKER purely to move the mark
const CASH = 100_000_000

function schedule(): EventConfig {
  return [{ id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: DEFAULT_USD_INR_RATE, commissionRate: 0 }]
}

async function harness() {
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: SHORTER, username: 'team01', team_name: 'A', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: MAKER, username: 'mm', team_name: null, role: 'market_maker', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: OTHER, username: 'team02', team_name: 'B', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const svc = new TradingService(db as unknown as SupabaseClient, new RoundController(schedule()))
  await svc.loadInstruments()
  await svc.startRound(0)
  return { db, svc }
}

/** SHORTER goes short `qty` at `price`, MAKER takes the other side. */
async function openShort(svc: TradingService, qty: number, price: number) {
  await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'buy', type: 'limit', price, qty, leverage: 1 })
  await svc.placeOrder({ accountId: SHORTER, ticker: 'AAPL', side: 'sell', type: 'limit', price, qty, leverage: 1 })
}

/**
 * Move the mark to `price` by making a real trade happen there.
 *
 * This is how the mark ACTUALLY moves: ltp() reads the last traded price, so
 * merely resting an order at a new price changes nothing. Liquidation is
 * therefore triggered by trading (or by the Master setting prices), which is
 * worth knowing operationally — a book that stops trading stops liquidating.
 */
async function markAt(svc: TradingService, price: number) {
  await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'sell', type: 'limit', price, qty: 1, leverage: 1 })
  await svc.placeOrder({ accountId: OTHER, ticker: 'AAPL', side: 'buy', type: 'limit', price, qty: 1, leverage: 1 })
}

/** MAKER rests an ask so a liquidation buy-back has something to hit. */
const restAsk = (svc: TradingService, price: number, qty: number) =>
  svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'sell', type: 'limit', price, qty, leverage: 1 })

const positionOf = (db: FakeDb, id: string) => db.rows('positions').find((p) => p.account_id === id)
const logs = (db: FakeDb, type: string) => db.rows('event_log').filter((e) => e.event_type === type)

// ---------------------------------------------------------------------------

describe('a short that crosses its liquidation price is force-closed', () => {
  it('liquidates once the mark reaches 2x entry', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100) // short 10 @ $100 -> liquidation at $200
    expect(liquidationPrice({ qty: -10, avgPrice: 100, leverage: 1 })).toBe(200)

    await markAt(svc, 200)
    await restAsk(svc, 200, 10) // liquidity to buy back against; also marks at 200
    const done = await svc.sweepLiquidations()

    expect(done).toHaveLength(1)
    expect(done[0].ticker).toBe('AAPL')
    expect(done[0].side).toBe('buy') // buying back a short
    expect(done[0].filledQty).toBe(10)
    expect(done[0].partial).toBe(false)
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(0) // flat
  })

  it('records the mark and the threshold it crossed', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    const [done] = await svc.sweepLiquidations()

    expect(done.liquidationPrice).toBe(200)
    expect(done.markPrice).toBe(200)
    expect(done.entryPrice).toBe(100)
    expect(done.leverage).toBe(1)
  })

  it('the P&L is the real loss, settled at the round rate', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()

    // Short 10 @ $100, bought back at $200: (100 - 200) * 10 * rate.
    const expected = (100 - 200) * 10 * DEFAULT_USD_INR_RATE
    expect(Number(db.profile(SHORTER)!.realized_pnl_inr)).toBeCloseTo(expected, 6)
  })

  it('wipes out roughly the whole margin posted, which is the point', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()

    // Margin posted was |qty| * entry * rate / 1 = the same magnitude as the loss.
    const posted = 10 * 100 * DEFAULT_USD_INR_RATE
    expect(Math.abs(Number(db.profile(SHORTER)!.realized_pnl_inr))).toBeCloseTo(posted, 6)
  })

  it('the closing trade appears in the account Trade History like any other', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()

    const h = (await svc.portfolio(SHORTER)).tradeHistory as { qty: number; side: string }[]
    expect(h).toHaveLength(1)
    expect(h[0].side).toBe('short')
    expect(h[0].qty).toBe(10)
  })

  it('frees the margin it was holding', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()

    const state = await svc.getAccountState(SHORTER)
    expect(state.marginUsedInr).toBe(0)
  })

  it('does not fire twice — the position is gone after the first sweep', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 20)
    expect(await svc.sweepLiquidations()).toHaveLength(1)
    expect(await svc.sweepLiquidations()).toHaveLength(0)
  })
})

describe('a position that has NOT crossed is left alone', () => {
  it('a short below its liquidation price is untouched', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100) // liquidation at 200
    await markAt(svc, 150) // painful, not fatal

    expect(await svc.sweepLiquidations()).toEqual([])
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10) // still open
  })

  it('one tick short of the threshold is still safe', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 199.99)
    expect(await svc.sweepLiquidations()).toEqual([])
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10)
  })

  it('a LONG at 1x is never liquidated — it can only lose what it paid', async () => {
    const { db, svc } = await harness()
    // MAKER shorts so SHORTER can go long; then the price collapses.
    await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'sell', type: 'limit', price: 100, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: SHORTER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 100, qty: 10, leverage: 1 })
    expect(liquidationPrice({ qty: 10, avgPrice: 100, leverage: 1 })).toBe(0)

    await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'sell', type: 'limit', price: 1, qty: 1, leverage: 1 })
    await svc.placeOrder({ accountId: SHORTER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 1, qty: 1, leverage: 1 })

    expect(await svc.sweepLiquidations()).toEqual([])
    expect(Number(positionOf(db, SHORTER)!.qty)).toBeGreaterThan(0)
  })

  it('nothing happens when no round is active', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.endRound(0)
    expect(await svc.sweepLiquidations()).toEqual([])
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10)
  })

  it('a flat account is never considered', async () => {
    const { svc } = await harness()
    expect(await svc.sweepLiquidations()).toEqual([])
  })
})

describe('it is logged for audit', () => {
  it('writes position_liquidated with account, instrument, prices and size', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()

    const [row] = logs(db, 'position_liquidated')
    expect(row).toBeDefined()
    expect(row.account_id).toBe(SHORTER)
    expect(row.severity).toBe('warning')
    expect(row.payload.ticker).toBe('AAPL')
    expect(row.payload.markPrice).toBe(200)
    expect(row.payload.liquidationPrice).toBe(200)
    expect(row.payload.entryPrice).toBe(100)
    expect(row.payload.qty).toBe(10)
    expect(row.payload.filledQty).toBe(10)
    expect(row.payload.usdInrRate).toBe(DEFAULT_USD_INR_RATE)
  })

  it('logs nothing when nothing is liquidated', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 150)
    await svc.sweepLiquidations()
    expect(logs(db, 'position_liquidated')).toHaveLength(0)
  })
})

describe('the team is told, not silently closed', () => {
  it('publishes a notification naming the account and the instrument', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()

    const notes = db.rows('notifications')
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toContain('Liquidated')
    expect(notes[0].title).toContain('team01')
    expect(notes[0].title).toContain('AAPL')
    expect(notes[0].body).toContain('200.00')
  })

  it('the account sees a flat position on its next poll', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()

    const after = await svc.portfolio(SHORTER)
    expect(after.openPositions).toBe(0)
    expect(after.marginUsedInr).toBe(0)
    expect(after.totalPortfolioValueInr).toBeCloseTo(CASH - 10 * 100 * DEFAULT_USD_INR_RATE, 6)
  })

  it('CASH is unchanged — and that is exactly what liquidation means at 1x', async () => {
    // The loss equals the margin that was posted, to the rupee: margin comes
    // back, the loss takes it straight away again. Spendable cash therefore does
    // not move, while total value falls by the full margin. That identity is the
    // definition of being wiped out, not a bug, and it is worth pinning so
    // nobody later "fixes" it.
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    const before = await svc.portfolio(SHORTER)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.sweepLiquidations()
    const after = await svc.portfolio(SHORTER)

    const posted = 10 * 100 * DEFAULT_USD_INR_RATE
    expect(before.marginUsedInr).toBeCloseTo(posted, 6)
    expect(after.cashInr).toBeCloseTo(before.cashInr as number, 6) // unchanged
    expect(after.realizedPnlInr).toBeCloseTo(-posted, 6) // the margin, gone
    expect((before.totalPortfolioValueInr as number) - (after.totalPortfolioValueInr as number))
      .toBeCloseTo(posted, 6)
  })
})

describe('a book too thin to absorb it', () => {
  it('closes what it can and marks the rest partial', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 4) // only 4 available against a 10 short

    const [done] = await svc.sweepLiquidations()
    expect(done.filledQty).toBe(4)
    expect(done.partial).toBe(true)
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-6) // the rest survives
  })

  it('says so in the notification rather than implying a clean close', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 4)
    await svc.sweepLiquidations()
    expect(db.rows('notifications')[0].body).toContain('could not be filled')
  })

  it('tries again on the next sweep while the position remains underwater', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 200)
    await restAsk(svc, 200, 4)
    await svc.sweepLiquidations()
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-6)

    await restAsk(svc, 200, 6) // liquidity returns
    await svc.sweepLiquidations()
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(0)
  })
})
