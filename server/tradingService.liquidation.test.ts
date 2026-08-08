// @vitest-environment node
/**
 * Liquidation: continuous DETECTION, manual ENFORCEMENT.
 *
 * liquidationPrice was computed and displayed everywhere and enforced nowhere.
 * Under the 1x-only model this is a SHORT problem specifically — a long
 * liquidates at E*(1 - 1/1) = 0, unreachable unless the stock hits zero, but a
 * short liquidates at E*(1 + 1/1), the moment the price doubles.
 *
 * Nothing fires on a timer. The market maker sees who is past their threshold
 * and decides, position by position, whether to close. These tests drive the
 * real TradingService: a real book, real fills, real settlement.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, liquidationPrice, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 100 }
const SHORTER = 'acct-short' // opens the short that goes underwater
const MAKER = 'acct-maker' // the market maker: sees the list, presses the button
const OTHER = 'acct-other' // trades with MAKER purely to move the mark
const MASTER = 'acct-master'
const CASH = 100_000_000

const MM = { accountId: MAKER, role: 'market_maker' }
const AS_MASTER = { accountId: MASTER, role: 'master' }
const AS_TEAM = { accountId: OTHER, role: 'team' }
/** An unauthenticated caller reaches the service with no role at all. */
const ANON = { accountId: '', role: '' }

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
      { id: MASTER, username: 'master', team_name: null, role: 'master', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
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
 * Move the mark by making a real trade happen there.
 *
 * This is how the mark ACTUALLY moves: ltp() is the last TRADED price, so
 * resting an order at a new price changes nothing. Detection therefore updates
 * on trading (or on the Master setting prices).
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
const listed = async (svc: TradingService, id: string) =>
  (await svc.liquidatablePositions(MM)).some((r) => r.accountId === id)

/** Short 10 @ $100 (liquidation $200), mark driven to $200, liquidity waiting. */
async function underwater(svc: TradingService, askQty = 10) {
  await openShort(svc, 10, 100)
  await markAt(svc, 200)
  await restAsk(svc, 200, askQty)
}

// ---------------------------------------------------------------------------

describe('detection: which positions are past their threshold', () => {
  it('lists a short whose mark has reached 2x entry', async () => {
    const { svc } = await harness()
    expect(liquidationPrice({ qty: -10, avgPrice: 100, leverage: 1 })).toBe(200)
    await underwater(svc)

    const row = (await svc.liquidatablePositions(MM)).find((r) => r.accountId === SHORTER)!
    expect(row).toBeDefined()
    expect(row.username).toBe('team01')
    expect(row.ticker).toBe('AAPL')
    expect(row.side).toBe('short')
    expect(row.qty).toBe(-10)
    expect(row.entryPrice).toBe(100)
    expect(row.markPrice).toBe(200)
    expect(row.liquidationPrice).toBe(200)
  })

  it('reports how far PAST the threshold it is', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100) // liquidation at 200
    await markAt(svc, 220) // 20 beyond it

    const row = (await svc.liquidatablePositions(MM)).find((r) => r.accountId === SHORTER)!
    expect(row.pastByUsd).toBe(20)
    expect(row.pastByPct).toBeCloseTo(10, 6) // 20 / 200
  })

  it('does NOT list a short that is merely losing', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 150) // painful, not fatal
    expect(await listed(svc, SHORTER)).toBe(false)
  })

  it('one tick short of the threshold is still safe', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 199.99)
    expect(await listed(svc, SHORTER)).toBe(false)
  })

  it('never lists a LONG at 1x — it can only lose what it paid', async () => {
    const { svc } = await harness()
    await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'sell', type: 'limit', price: 100, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: SHORTER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 100, qty: 10, leverage: 1 })
    expect(liquidationPrice({ qty: 10, avgPrice: 100, leverage: 1 })).toBe(0)
    await markAt(svc, 1) // collapse
    expect(await listed(svc, SHORTER)).toBe(false)
  })

  it('sorts worst-first so the most urgent is at the top', async () => {
    const { svc } = await harness()
    await openShort(svc, 10, 100) // liq 200
    await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 120, qty: 5, leverage: 1 })
    await svc.placeOrder({ accountId: OTHER, ticker: 'AAPL', side: 'sell', type: 'limit', price: 120, qty: 5, leverage: 1 })
    await markAt(svc, 260)

    const list = await svc.liquidatablePositions(MM)
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list[0].pastByPct).toBeGreaterThanOrEqual(list[1].pastByPct)
  })

  it('is empty when nothing is underwater, and when no round is active', async () => {
    const { svc } = await harness()
    expect(await svc.liquidatablePositions(MM)).toEqual([])
    await underwater(svc)
    await svc.endRound(0)
    expect(await svc.liquidatablePositions(MM)).toEqual([])
  })

  it('DETECTION ALONE CLOSES NOTHING — the whole point of the redesign', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    await svc.liquidatablePositions(MM)
    await svc.liquidatablePositions(MM)
    await svc.liquidatablePositions(MM)
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10) // untouched
    expect(logs(db, 'position_liquidated')).toHaveLength(0)
  })
})

describe('only the market maker may see or act', () => {
  it('master gets an empty list', async () => {
    const { svc } = await harness()
    await underwater(svc)
    expect(await svc.liquidatablePositions(AS_MASTER)).toEqual([])
  })

  it('a team gets an empty list', async () => {
    const { svc } = await harness()
    await underwater(svc)
    expect(await svc.liquidatablePositions(AS_TEAM)).toEqual([])
  })

  it('an unauthenticated caller gets an empty list', async () => {
    const { svc } = await harness()
    await underwater(svc)
    expect(await svc.liquidatablePositions(ANON)).toEqual([])
  })

  it('MASTER cannot trigger a close', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    const res = await svc.liquidatePosition(AS_MASTER, SHORTER, 'AAPL')
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('forbidden')
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10)
  })

  it('a TEAM cannot trigger a close', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    const res = await svc.liquidatePosition(AS_TEAM, SHORTER, 'AAPL')
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('forbidden')
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10)
  })

  it('an account cannot liquidate ITSELF to dodge the queue', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    const res = await svc.liquidatePosition({ accountId: SHORTER, role: 'team' }, SHORTER, 'AAPL')
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('forbidden')
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10)
  })

  it('an unauthenticated caller cannot trigger a close', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    expect((await svc.liquidatePosition(ANON, SHORTER, 'AAPL')).reason).toBe('forbidden')
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10)
  })

  it('a refused attempt logs nothing — no audit noise from a blocked caller', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    await svc.liquidatePosition(AS_MASTER, SHORTER, 'AAPL')
    await svc.liquidatePosition(AS_TEAM, SHORTER, 'AAPL')
    expect(logs(db, 'position_liquidated')).toHaveLength(0)
  })
})

describe('the market maker triggers a close', () => {
  it('force-closes the position at market', async () => {
    const { db, svc } = await harness()
    await underwater(svc)

    const res = await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(res.applied).toBe(true)
    expect(res.event!.side).toBe('buy') // buying back a short
    expect(res.event!.filledQty).toBe(10)
    expect(res.event!.partial).toBe(false)
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(0)
  })

  it('the P&L is the real loss, settled at the round rate', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')

    expect(Number(db.profile(SHORTER)!.realized_pnl_inr))
      .toBeCloseTo((100 - 200) * 10 * DEFAULT_USD_INR_RATE, 6)
  })

  it('frees the margin, and the trade lands in Trade History', async () => {
    const { svc } = await harness()
    await underwater(svc)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')

    expect((await svc.getAccountState(SHORTER)).marginUsedInr).toBe(0)
    const h = (await svc.portfolio(SHORTER)).tradeHistory as { qty: number; side: string }[]
    expect(h).toHaveLength(1)
    expect(h[0].side).toBe('short')
  })

  it('CASH is unchanged — which is exactly what liquidation means at 1x', async () => {
    // The loss equals the margin posted, to the rupee: margin returns, the loss
    // takes it straight back. Total value falls by the full margin while
    // spendable cash does not move. Pinned so nobody later "fixes" it.
    const { svc } = await harness()
    await openShort(svc, 10, 100)
    const before = await svc.portfolio(SHORTER)
    await markAt(svc, 200)
    await restAsk(svc, 200, 10)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    const after = await svc.portfolio(SHORTER)

    const posted = 10 * 100 * DEFAULT_USD_INR_RATE
    expect(before.marginUsedInr).toBeCloseTo(posted, 6)
    expect(after.cashInr).toBeCloseTo(before.cashInr as number, 6)
    expect(after.realizedPnlInr).toBeCloseTo(-posted, 6)
  })

  it('drops off the liquidatable list once closed', async () => {
    const { svc } = await harness()
    await underwater(svc, 20)
    expect(await listed(svc, SHORTER)).toBe(true)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(await listed(svc, SHORTER)).toBe(false)
  })

  it('a second press on a closed position is refused, not silently repeated', async () => {
    const { svc } = await harness()
    await underwater(svc, 20)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    const again = await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(again.applied).toBe(false)
    expect(again.reason).toBe('no open position')
  })
})

describe('market-maker authority is unrestricted within the role', () => {
  /**
   * The threshold is a REFERENCE, not a permission check. The desk decides when
   * a position must go; the list exists to inform that judgement. Accountability
   * comes from the audit trail, which records exactly what was closed and at
   * what mark — not from the server second-guessing the call.
   */
  it('CAN close a merely-losing short that has not crossed its threshold', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100) // liquidation at 200
    await markAt(svc, 150) // nowhere near it
    await restAsk(svc, 150, 10)
    expect(await listed(svc, SHORTER)).toBe(false) // not on the list...

    const res = await svc.liquidatePosition(MM, SHORTER, 'AAPL') // ...closed anyway
    expect(res.applied).toBe(true)
    expect(res.event!.filledQty).toBe(10)
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(0)
  })

  it('CAN close a healthy long', async () => {
    const { db, svc } = await harness()
    await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'sell', type: 'limit', price: 100, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: SHORTER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 100, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: MAKER, ticker: 'AAPL', side: 'buy', type: 'limit', price: 100, qty: 10, leverage: 1 })

    const res = await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(res.applied).toBe(true)
    expect(res.event!.side).toBe('sell') // selling out a long
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(0)
  })

  it('a discretionary close is audited identically — same trail, same detail', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 150)
    await restAsk(svc, 150, 10)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')

    const [row] = logs(db, 'position_liquidated')
    expect(row.account_id).toBe(SHORTER)
    expect(row.payload.markPrice).toBe(150)
    expect(row.payload.liquidationPrice).toBe(200) // still recorded, not enforced
    expect(row.payload.triggeredBy).toBe('market_maker')
    expect(row.payload.triggeredByAccountId).toBe(MAKER)
  })

  it('team and master still cannot do it — the role gate is untouched', async () => {
    const { db, svc } = await harness()
    await openShort(svc, 10, 100)
    await markAt(svc, 150)
    await restAsk(svc, 150, 10)

    expect((await svc.liquidatePosition(AS_TEAM, SHORTER, 'AAPL')).reason).toBe('forbidden')
    expect((await svc.liquidatePosition(AS_MASTER, SHORTER, 'AAPL')).reason).toBe('forbidden')
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-10)
  })

  it('refuses an account with no position at all', async () => {
    const { svc } = await harness()
    expect((await svc.liquidatePosition(MM, SHORTER, 'AAPL')).reason).toBe('no open position')
  })

  it('refuses an unknown instrument', async () => {
    const { svc } = await harness()
    expect((await svc.liquidatePosition(MM, SHORTER, 'ZZZZ')).reason).toContain('unknown instrument')
  })

  it('refuses when no round is active', async () => {
    const { svc } = await harness()
    await underwater(svc)
    await svc.endRound(0)
    expect((await svc.liquidatePosition(MM, SHORTER, 'AAPL')).reason).toBe('no active round')
  })
})

describe('audit: recorded as market-maker-triggered, never automatic', () => {
  it('logs position_liquidated with the full picture', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')

    const [row] = logs(db, 'position_liquidated')
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

  it('records WHO triggered it', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')

    const [row] = logs(db, 'position_liquidated')
    expect(row.payload.triggeredBy).toBe('market_maker')
    expect(row.payload.triggeredByAccountId).toBe(MAKER)
  })

  it('the returned event says so too', async () => {
    const { svc } = await harness()
    await underwater(svc)
    const res = await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(res.event!.triggeredBy).toBe('market_maker')
    expect(res.event!.triggeredByAccountId).toBe(MAKER)
  })

  it('notifies rather than closing silently', async () => {
    const { db, svc } = await harness()
    await underwater(svc)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')

    const notes = db.rows('notifications')
    expect(notes).toHaveLength(1)
    expect(notes[0].title).toContain('Liquidated')
    expect(notes[0].title).toContain('team01')
    expect(notes[0].body).toContain('Mark 200.00')
  })
})

describe('a book too thin to absorb it', () => {
  it('closes what it can and marks the rest partial', async () => {
    const { db, svc } = await harness()
    await underwater(svc, 4) // only 4 available against a 10 short

    const res = await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(res.event!.filledQty).toBe(4)
    expect(res.event!.partial).toBe(true)
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(-6)
  })

  it('says so in the notification rather than implying a clean close', async () => {
    const { db, svc } = await harness()
    await underwater(svc, 4)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(db.rows('notifications')[0].body).toContain('could not be filled')
  })

  it('stays on the list so the market maker can finish the job', async () => {
    const { db, svc } = await harness()
    await underwater(svc, 4)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(await listed(svc, SHORTER)).toBe(true)

    await restAsk(svc, 200, 6)
    await svc.liquidatePosition(MM, SHORTER, 'AAPL')
    expect(Number(positionOf(db, SHORTER)!.qty)).toBe(0)
  })
})
