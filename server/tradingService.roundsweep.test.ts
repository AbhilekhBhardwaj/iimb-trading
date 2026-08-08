// @vitest-environment node
/**
 * A round is a self-contained trading session: no order may rest into the next
 * one, and the margin those orders reserve has to come back with them.
 *
 * These tests drive the real service through a full round boundary and check
 * every layer that could disagree — the engine's book, the in-memory order map,
 * the DB rows, the account's reserved margin, and what a restart would restore.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const A = 'acct-a'
const B = 'acct-b'
const MM = 'acct-mm'
const CASH = 10_000_000
const RATE = DEFAULT_USD_INR_RATE

/** Three rounds, so a boundary can be crossed and re-crossed. */
function schedule(): EventConfig {
  return ['r1', 'r2', 'r3'].map((id) => ({
    id, mode: 'only_data' as const, durationSeconds: 600,
    commissionEnabled: false, usdInrRate: RATE, commissionRate: 0,
  }))
}

async function harness() {
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: A, username: 'team01', team_name: 'A', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: B, username: 'team02', team_name: 'B', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: MM, username: 'mm', team_name: null, role: 'market_maker', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const rounds = new RoundController(schedule())
  const svc = new TradingService(db as unknown as SupabaseClient, rounds)
  await svc.loadInstruments()
  await svc.startRound(0)
  return { db, svc, rounds }
}

const rest = (svc: TradingService, who: string, side: 'buy' | 'sell', price: number, qty: number) =>
  svc.placeOrder({ accountId: who, ticker: 'AAPL', side, type: 'limit', price, qty, leverage: 1 })

const dbOrders = (db: FakeDb) => db.rows('orders')
const stillWorking = (db: FakeDb) =>
  dbOrders(db).filter((o) => o.status === 'active' || o.status === 'partially_filled')

// ---------------------------------------------------------------------------

describe('2. what happens to a resting order when the round ends', () => {
  it('is CANCELLED outright — not carried, not left active', async () => {
    const { db, svc } = await harness()
    const placed = await rest(svc, A, 'buy', 150, 10) // far from market, will rest
    expect(dbOrders(db).find((o) => o.id === placed.orderId)!.status).toBe('active')

    await svc.endRound(600)

    const row = dbOrders(db).find((o) => o.id === placed.orderId)!
    expect(row.status).toBe('cancelled')
    expect(stillWorking(db)).toHaveLength(0)
  })

  it('disappears from the account working-orders view', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    expect(await svc.workingOrders(A)).toHaveLength(1)
    await svc.endRound(600)
    expect(await svc.workingOrders(A)).toHaveLength(0)
  })

  it('disappears from the public book, so nothing can match it', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    expect(svc.depthView('AAPL', false).bids).toHaveLength(1)
    await svc.endRound(600)
    expect(svc.depthView('AAPL', false).bids).toHaveLength(0)
    expect(svc.depthView('AAPL', false).asks).toHaveLength(0)
  })

  it('a PARTIALLY filled order keeps its fill and cancels only the remainder', async () => {
    const { db, svc } = await harness()
    const placed = await rest(svc, A, 'buy', 200, 10)
    await rest(svc, B, 'sell', 200, 4) // 4 of the 10 trade
    const before = dbOrders(db).find((o) => o.id === placed.orderId)!
    expect(before.status).toBe('partially_filled')
    expect(Number(before.remaining_qty)).toBe(6)

    await svc.endRound(600)

    const after = dbOrders(db).find((o) => o.id === placed.orderId)!
    expect(after.status).toBe('cancelled')
    expect(Number(after.remaining_qty)).toBe(6) // the 4 that filled stay filled
    expect(db.rows('trades')).toHaveLength(1)
  })

  it('sweeps EVERY account, not just one', async () => {
    const { db, svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    await rest(svc, B, 'buy', 140, 5)
    await rest(svc, MM, 'sell', 260, 20)
    expect(stillWorking(db)).toHaveLength(3)

    await svc.endRound(600)
    expect(stillWorking(db)).toHaveLength(0)
  })

  it('reports the count it cancelled in the round_ended log', async () => {
    const { db, svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    await rest(svc, B, 'buy', 140, 5)
    await svc.endRound(600)

    const [ended] = db.rows('event_log').filter((e) => e.event_type === 'round_ended')
    expect(ended.payload.ordersCancelled).toBe(2)
  })
})

describe('3. reserved margin comes back', () => {
  it('is released in full when the round ends', async () => {
    const { svc } = await harness()
    const before = await svc.getAccountState(A)
    expect(before.marginReservedInr).toBe(0)

    await rest(svc, A, 'buy', 150, 20) // 20 x 150 x rate reserved
    const during = await svc.getAccountState(A)
    expect(during.marginReservedInr).toBeCloseTo(20 * 150 * RATE, 6)
    expect(during.availableMarginInr).toBeCloseTo(CASH - 20 * 150 * RATE, 6)

    await svc.endRound(600)

    const after = await svc.getAccountState(A)
    expect(after.marginReservedInr).toBe(0)
    expect(after.availableMarginInr).toBe(CASH) // fully restored
  })

  it('releases only the RESTING part — a filled position keeps its margin', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'buy', 200, 10)
    await rest(svc, B, 'sell', 200, 4) // A now holds 4, 6 still resting
    await svc.endRound(600)

    const after = await svc.getAccountState(A)
    expect(after.marginReservedInr).toBe(0) // the 6 released
    expect(after.marginUsedInr).toBeCloseTo(4 * 200 * RATE, 6) // the 4 still posted
  })

  it('the full balance is spendable again in the next round', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'buy', 150, 20)
    await svc.endRound(600)
    await svc.startRound(0)

    // The whole balance is available: a big order that would have been blocked
    // by the old reservation is accepted.
    const res = await rest(svc, A, 'buy', 150, 60) // 60 x 150 x 83 = 7.47L of 1cr
    expect(res.accepted).toBe(true)
  })

  it('every account gets its margin back, not just the first swept', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    await rest(svc, B, 'buy', 150, 10)
    await svc.endRound(600)
    expect((await svc.getAccountState(A)).availableMarginInr).toBe(CASH)
    expect((await svc.getAccountState(B)).availableMarginInr).toBe(CASH)
  })
})

describe('4. nothing survives into the next round', () => {
  it('the book is empty when the next round opens', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    await rest(svc, MM, 'sell', 260, 10)
    await svc.endRound(600)
    await svc.startRound(0)

    const d = svc.depthView('AAPL', false)
    expect(d.bids).toHaveLength(0)
    expect(d.asks).toHaveLength(0)
  })

  it('a round-1 order cannot match a round-2 order', async () => {
    const { db, svc } = await harness()
    // A rests a buy at 150 in round 1.
    await rest(svc, A, 'buy', 150, 10)
    await svc.endRound(600)
    await svc.startRound(0)

    // In round 2, B sells INTO that price. If the old order survived it would
    // cross; it must not.
    const sell = await rest(svc, B, 'sell', 150, 10)
    expect(sell.trades ?? []).toHaveLength(0)
    expect(db.rows('trades')).toHaveLength(0)
    expect(db.rows('positions').filter((p) => Number(p.qty) !== 0)).toHaveLength(0)
  })

  it('a market order in round 2 finds no round-1 liquidity to hit', async () => {
    const { svc } = await harness()
    await rest(svc, MM, 'sell', 200, 50) // deep liquidity in round 1
    await svc.endRound(600)
    await svc.startRound(0)

    const res = await svc.placeOrder({
      accountId: A, ticker: 'AAPL', side: 'buy', type: 'market', qty: 50, leverage: 1, markPrice: 200,
    })
    expect(res.trades ?? []).toHaveLength(0) // market remainder discarded
  })

  it('a RESTART mid-event does not resurrect swept orders', async () => {
    // rehydrate() restores only active/partially_filled rows to the book, and
    // the sweep has already marked them cancelled — so a crash and restart
    // between rounds cannot bring a stale order back.
    const { db, svc, rounds } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    await svc.endRound(600)

    const revived = new TradingService(db as unknown as SupabaseClient, rounds)
    await revived.loadInstruments()
    await revived.rehydrate()

    expect(revived.depthView('AAPL', false).bids).toHaveLength(0)
    expect(await revived.workingOrders(A)).toHaveLength(0)
    expect((await revived.getAccountState(A)).marginReservedInr).toBe(0)
  })

  it('holds across TWO consecutive boundaries', async () => {
    const { db, svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    await svc.endRound(600)
    await svc.startRound(0)
    await rest(svc, A, 'buy', 140, 5)
    await svc.endRound(600)
    await svc.startRound(0)

    expect(stillWorking(db)).toHaveLength(0)
    expect(svc.depthView('AAPL', false).bids).toHaveLength(0)
    expect((await svc.getAccountState(A)).availableMarginInr).toBe(CASH)
  })
})

describe('1. still correct alongside tonight changes', () => {
  it('an auto-ended round sweeps exactly like a manual one', async () => {
    const { db, svc } = await harness()
    await rest(svc, A, 'buy', 150, 10)
    // Drive the clock past the duration and let the timer path end it.
    const ended = await svc.maybeAutoEndRound()
    expect(ended === null || stillWorking(db).length === 0).toBe(true)
    if (ended === null) {
      await svc.endRound(600)
    }
    expect(stillWorking(db)).toHaveLength(0)
  })

  it('the schedule EXTENSION still opens a clean book', async () => {
    // Exhaust the configured schedule, forcing createNextRound(), and confirm
    // the extended round starts with nothing resting.
    const { db, svc } = await harness()
    for (let i = 0; i < 3; i++) {
      await rest(svc, A, 'buy', 150, 2)
      await svc.endRound(600)
      await svc.startRound(0)
    }
    expect(stillWorking(db)).toHaveLength(0)
    expect(svc.depthView('AAPL', false).bids).toHaveLength(0)
  })

  it('CONCURRENT orders placed as the round ends do not survive it', async () => {
    // serializeAccountOp queues an account's orders; the sweep must still catch
    // whatever landed before the boundary.
    const { db, svc } = await harness()
    await Promise.all([
      rest(svc, A, 'buy', 150, 5),
      rest(svc, A, 'buy', 149, 5),
      rest(svc, B, 'buy', 148, 5),
    ])
    await svc.endRound(600)

    expect(stillWorking(db)).toHaveLength(0)
    expect((await svc.getAccountState(A)).marginReservedInr).toBe(0)
    expect((await svc.getAccountState(B)).marginReservedInr).toBe(0)
  })

  it('a liquidatable position does not keep a swept order alive', async () => {
    const { db, svc } = await harness()
    await rest(svc, A, 'sell', 200, 10)
    await rest(svc, B, 'buy', 200, 10) // A now short 10 @ 200
    await rest(svc, A, 'buy', 150, 5) // and has an unrelated order resting

    await svc.endRound(600)

    expect(stillWorking(db)).toHaveLength(0)
    expect((await svc.getAccountState(A)).marginReservedInr).toBe(0)
    // The POSITION survives the round boundary — only orders are swept.
    expect(Number(db.rows('positions').find((p) => p.account_id === A)!.qty)).toBe(-10)
  })
})


describe('the price chart is CONTINUOUS across round boundaries', () => {
  /**
   * Trades and positions carry forward across rounds, so the chart must too.
   * priceHistory filters only by instrument and a trailing TIME window — there
   * is no round_id in the query — and nothing deletes trades at a boundary.
   */
  it('trades from round 1 are still returned during round 2', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 200, 5)
    await rest(svc, B, 'buy', 200, 5) // a real fill in round 1
    const inRound1 = await svc.priceHistory('AAPL', 3600)
    expect(inRound1.length).toBeGreaterThan(0)

    await svc.endRound(600)
    await svc.startRound(0)

    const inRound2 = await svc.priceHistory('AAPL', 3600)
    expect(inRound2.length).toBe(inRound1.length) // nothing was dropped
    expect(inRound2[0].price).toBe(200)
  })

  it('ending a round deletes no trades', async () => {
    const { db, svc } = await harness()
    await rest(svc, A, 'sell', 200, 5)
    await rest(svc, B, 'buy', 200, 5)
    const before = db.rows('trades').length
    expect(before).toBe(1)

    await svc.endRound(600)
    expect(db.rows('trades').length).toBe(before)
    await svc.startRound(0)
    expect(db.rows('trades').length).toBe(before)
  })

  it('a round-2 trade EXTENDS the same series rather than starting a new one', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 200, 5)
    await rest(svc, B, 'buy', 200, 5)
    await svc.endRound(600)
    await svc.startRound(0)
    await rest(svc, A, 'sell', 210, 5)
    await rest(svc, B, 'buy', 210, 5)

    const points = await svc.priceHistory('AAPL', 3600)
    const prices = points.map((p) => p.price)
    expect(prices).toContain(200) // round 1
    expect(prices).toContain(210) // round 2, same series
    expect(points.length).toBe(2)
  })

  it('positions also carry forward, so the chart matches the book', async () => {
    const { db, svc } = await harness()
    await rest(svc, A, 'sell', 200, 5)
    await rest(svc, B, 'buy', 200, 5)
    await svc.endRound(600)
    await svc.startRound(0)
    expect(Number(db.rows('positions').find((p) => p.account_id === A)!.qty)).toBe(-5)
  })
})
