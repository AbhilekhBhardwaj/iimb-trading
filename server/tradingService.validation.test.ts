// @vitest-environment node
/**
 * Order input validation, at the service layer.
 *
 * Two integrity gaps found by QA:
 *
 *   qty 2.5 was ACCEPTED and rested on the book. The gate was `qty > 0`, which
 *   a fraction satisfies, and the matching engine assumes whole lots.
 *
 *   side "hold" — or any typo — EXECUTED AS A BUY. The API coerced with
 *   `b.side === 'sell' ? 'sell' : 'buy'`, so anything that was not exactly the
 *   string 'sell' opened a long nobody asked for. The dangerous one: a
 *   malformed request did not fail, it traded.
 *
 * Both are now checked in placeOrder, BEFORE the order reaches the engine, so
 * every caller gets the guarantee rather than just the HTTP layer.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { type RejectionCode, TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const A = 'acct-a'
const B = 'acct-b'
const CASH = 100_000_000

function schedule(): EventConfig {
  return [{ id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: DEFAULT_USD_INR_RATE, commissionRate: 0 }]
}

async function harness() {
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: A, username: 'team01', team_name: 'A', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: B, username: 'team02', team_name: 'B', role: 'team', starting_cash: CASH, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const svc = new TradingService(db as unknown as SupabaseClient, new RoundController(schedule()))
  await svc.loadInstruments()
  await svc.startRound(0)
  return { db, svc }
}

/** Deliberately loose so garbage can be pushed through, as a raw request would. */
const place = (svc: TradingService, over: Record<string, unknown> = {}) =>
  svc.placeOrder({
    accountId: A, ticker: 'AAPL', side: 'buy', type: 'limit', price: 200, qty: 10, leverage: 1,
    ...over,
  } as never)

const positionQty = (db: FakeDb, id: string) =>
  Number(db.rows('positions').find((p) => p.account_id === id)?.qty ?? 0)

// ---------------------------------------------------------------------------

describe('quantity must be a whole number of at least 1', () => {
  it('rejects 2.5 — the reported case', async () => {
    const { db, svc } = await harness()
    const res = await place(svc, { qty: 2.5 })
    expect(res.accepted).toBe(false)
    expect(res.rejection?.code).toBe<RejectionCode>('invalid_qty')
    expect(db.rows('orders')).toHaveLength(0) // nothing rested
  })

  it.each([0.1, 0.5, 1.5, 9.99, 2.5])('rejects fractional qty %s', async (qty) => {
    const { svc } = await harness()
    expect((await place(svc, { qty })).rejection?.code).toBe<RejectionCode>('invalid_qty')
  })

  it('rejects 0 — still true, as before', async () => {
    const { svc } = await harness()
    expect((await place(svc, { qty: 0 })).rejection?.code).toBe<RejectionCode>('invalid_qty')
  })

  it('rejects negatives', async () => {
    const { svc } = await harness()
    expect((await place(svc, { qty: -5 })).rejection?.code).toBe<RejectionCode>('invalid_qty')
    expect((await place(svc, { qty: -2.5 })).rejection?.code).toBe<RejectionCode>('invalid_qty')
  })

  it('rejects NaN and Infinity rather than letting them reach the engine', async () => {
    const { svc } = await harness()
    for (const qty of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect((await place(svc, { qty })).rejection?.code).toBe<RejectionCode>('invalid_qty')
    }
  })

  it('rejects a non-numeric quantity', async () => {
    const { svc } = await harness()
    for (const qty of ['10', null, undefined, {}]) {
      expect((await place(svc, { qty })).rejection?.code).toBe<RejectionCode>('invalid_qty')
    }
  })

  it('ACCEPTS 1, and any whole number', async () => {
    const { svc } = await harness()
    for (const qty of [1, 2, 10, 45, 1000]) {
      expect((await place(svc, { qty })).accepted).toBe(true)
    }
  })
})

describe('side must be exactly buy or sell — never defaulted', () => {
  it('rejects "hold" instead of executing it as a BUY', async () => {
    const { db, svc } = await harness()
    const res = await place(svc, { side: 'hold' })
    expect(res.accepted).toBe(false)
    expect(res.rejection?.code).toBe<RejectionCode>('invalid_side')
    // The heart of it: no position was opened.
    expect(positionQty(db, A)).toBe(0)
    expect(db.rows('orders')).toHaveLength(0)
  })

  it.each(['hold', 'BUY', 'Sell', 'sel', 'bu', 'long', 'short', '', ' ', 'buy '])(
    'rejects %p rather than guessing',
    async (side) => {
      const { db, svc } = await harness()
      expect((await place(svc, { side })).rejection?.code).toBe<RejectionCode>('invalid_side')
      expect(positionQty(db, A)).toBe(0)
    },
  )

  it('rejects non-string sides', async () => {
    const { svc } = await harness()
    for (const side of [null, undefined, 0, 1, true, {}, ['buy']]) {
      expect((await place(svc, { side })).rejection?.code).toBe<RejectionCode>('invalid_side')
    }
  })

  it('case matters — "BUY" is not "buy"', async () => {
    const { db, svc } = await harness()
    await place(svc, { side: 'BUY' })
    expect(positionQty(db, A)).toBe(0) // would have been +10 under the old coercion
  })

  it('is checked BEFORE anything else, so garbage never reaches the engine', async () => {
    const { db, svc } = await harness()
    // Bad side AND bad everything else: side is what comes back.
    const res = await place(svc, { side: 'hold', qty: 2.5, ticker: 'ZZZZ' })
    expect(res.rejection?.code).toBe<RejectionCode>('invalid_side')
    expect(db.rows('orders')).toHaveLength(0)
  })

  it('logs the rejection for audit like any other', async () => {
    const { db, svc } = await harness()
    await place(svc, { side: 'hold' })
    const logged = db.rows('event_log').filter((e) => e.event_type === 'order_rejected')
    expect(logged).toHaveLength(1)
    expect(logged[0].payload.reason).toContain('invalid side')
  })
})

describe('valid orders are completely unaffected', () => {
  it('a BUY still opens a long', async () => {
    const { db, svc } = await harness()
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'sell', type: 'limit', price: 200, qty: 10, leverage: 1 })
    const res = await place(svc, { side: 'buy', qty: 10 })
    expect(res.accepted).toBe(true)
    expect(positionQty(db, A)).toBe(10)
  })

  it('a SELL still opens a short', async () => {
    const { db, svc } = await harness()
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 200, qty: 10, leverage: 1 })
    const res = await place(svc, { side: 'sell', qty: 10 })
    expect(res.accepted).toBe(true)
    expect(positionQty(db, A)).toBe(-10)
  })

  it('a MARKET order still works', async () => {
    const { db, svc } = await harness()
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'sell', type: 'limit', price: 200, qty: 10, leverage: 1 })
    const res = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'market', qty: 10, leverage: 1, markPrice: 200 })
    expect(res.accepted).toBe(true)
    expect(positionQty(db, A)).toBe(10)
  })

  it('a resting limit order still rests', async () => {
    const { svc } = await harness()
    expect((await place(svc, { side: 'buy', price: 150, qty: 5 })).accepted).toBe(true)
    expect(await svc.workingOrders(A)).toHaveLength(1)
  })

  it('the other rejection reasons still fire as before', async () => {
    const { svc } = await harness()
    expect((await place(svc, { ticker: 'ZZZZ' })).rejection?.code).toBe<RejectionCode>('unknown_instrument')
    expect((await place(svc, { leverage: 0.5 })).rejection?.code).toBe<RejectionCode>('invalid_leverage')
    expect((await place(svc, { price: undefined })).rejection?.code).toBe<RejectionCode>('missing_limit_price')
  })
})
