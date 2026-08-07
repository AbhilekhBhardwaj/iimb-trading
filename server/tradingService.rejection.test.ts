// @vitest-environment node
/**
 * The server half of the rejection contract.
 *
 * src/lib/orderRejection.test.ts proves each code maps to a clear message. That
 * is worthless if the server never emits the code, so this file drives the REAL
 * TradingService down every one of placeOrder's rejection paths and asserts the
 * structured `rejection` payload comes back — including the margin figures that
 * used to reach `event_log` and stop there.
 *
 * It also pins the thing that made the bug invisible: a rejected order writes no
 * order row and moves no cash, yet answered with a shape the UI read as success.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { type RejectionCode, TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 230 }
const A = 'acct-a'
const B = 'acct-b'

function schedule(): EventConfig {
  return [
    { id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: DEFAULT_USD_INR_RATE, commissionRate: 0 },
  ]
}

/** `cash` is the starting balance in INR; the default is deliberately tiny. */
function harness(cash = 100_000) {
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: A, username: 'team01', team_name: 'A', role: 'team', starting_cash: cash, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: B, username: 'team02', team_name: 'B', role: 'team', starting_cash: 10_000_000, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const rounds = new RoundController(schedule())
  const svc = new TradingService(db as unknown as SupabaseClient, rounds)
  return { db, svc }
}

const buy = (over: Record<string, unknown> = {}) => ({
  accountId: A, ticker: 'AAPL', side: 'buy' as const, type: 'limit' as const, price: 230, qty: 10, leverage: 1, ...over,
})

// ---------------------------------------------------------------------------

describe('every rejection path returns a structured code', () => {
  it('no active round — before any round is started', async () => {
    const { svc } = harness()
    await svc.loadInstruments() // instruments known, but no round started
    const res = await svc.placeOrder(buy())
    expect(res.accepted).toBe(false)
    expect(res.rejection?.code).toBe<RejectionCode>('no_active_round')
  })

  it('unknown instrument, and it names the ticker', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    const res = await svc.placeOrder(buy({ ticker: 'ZZZZ' }))
    expect(res.rejection?.code).toBe<RejectionCode>('unknown_instrument')
    expect(res.rejection?.ticker).toBe('ZZZZ')
  })

  it('invalid quantity — zero', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    expect((await svc.placeOrder(buy({ qty: 0 }))).rejection?.code).toBe<RejectionCode>('invalid_qty')
  })

  it('invalid quantity — negative', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    expect((await svc.placeOrder(buy({ qty: -5 }))).rejection?.code).toBe<RejectionCode>('invalid_qty')
  })

  it('invalid leverage — below 1x', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    expect((await svc.placeOrder(buy({ leverage: 0.5 }))).rejection?.code).toBe<RejectionCode>('invalid_leverage')
  })

  it('missing limit price', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    expect((await svc.placeOrder(buy({ price: undefined }))).rejection?.code).toBe<RejectionCode>('missing_limit_price')
  })

  it('insufficient margin', async () => {
    const { svc } = harness(100_000) // ₹1 lakh
    await svc.loadInstruments()
    await svc.startRound(0)
    // 1,000 × $230 at ~₹83 ≈ ₹1.9 crore, far beyond ₹1 lakh.
    const res = await svc.placeOrder(buy({ qty: 1000 }))
    expect(res.rejection?.code).toBe<RejectionCode>('insufficient_margin')
  })
})

describe('insufficient margin carries the numbers across the wire', () => {
  it('reports what was required and what was available', async () => {
    const { svc } = harness(100_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    const res = await svc.placeOrder(buy({ qty: 1000 }))

    expect(res.rejection?.requiredInr).toBeGreaterThan(0)
    expect(res.rejection?.availableInr).toBe(100_000)
    // The whole point: the shortfall is real and computable client-side.
    expect(res.rejection!.requiredInr!).toBeGreaterThan(res.rejection!.availableInr!)
  })

  it('the required figure matches notional ÷ leverage at the round rate', async () => {
    const { svc } = harness(100_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    const res = await svc.placeOrder(buy({ qty: 1000, leverage: 1 }))
    // 1,000 × $230 × rate ÷ 1x
    expect(res.rejection?.requiredInr).toBeCloseTo(1000 * 230 * DEFAULT_USD_INR_RATE, 0)
  })

  it('leverage reduces the required figure, and the message would say so', async () => {
    const { svc } = harness(100_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    const at1x = await svc.placeOrder(buy({ qty: 1000, leverage: 1 }))
    const at5x = await svc.placeOrder(buy({ qty: 1000, leverage: 5 }))
    expect(at5x.rejection!.requiredInr!).toBeCloseTo(at1x.rejection!.requiredInr! / 5, 0)
  })

  it('available margin shrinks as orders rest, and the rejection reflects it', async () => {
    const { svc } = harness(1_000_000) // ₹10 lakh
    await svc.loadInstruments()
    await svc.startRound(0)
    await svc.placeOrder(buy({ qty: 30 })) // rests, reserving margin
    const res = await svc.placeOrder(buy({ qty: 1000 }))
    expect(res.rejection?.code).toBe<RejectionCode>('insufficient_margin')
    expect(res.rejection!.availableInr!).toBeLessThan(1_000_000)
  })
})

describe('a rejected order changes nothing — which is why silence was dangerous', () => {
  it('writes no order row', async () => {
    const { db, svc } = harness(100_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    await svc.placeOrder(buy({ qty: 1000 }))
    expect(db.rows('orders').length).toBe(0)
  })

  it('carries no trades, no orderId — the shape that read as "resting"', async () => {
    const { svc } = harness(100_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    const res = await svc.placeOrder(buy({ qty: 1000 }))
    expect(res.trades).toBeUndefined()
    expect(res.orderId).toBeUndefined()
    // The ONLY thing distinguishing it from an unfilled-but-accepted order.
    expect(res.accepted).toBe(false)
  })

  it('logs the rejection for the master', async () => {
    const { db, svc } = harness(100_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    await svc.placeOrder(buy({ qty: 1000 }))
    const logged = db.rows('event_log').filter((e) => e.event_type === 'order_rejected')
    expect(logged.length).toBe(1)
  })
})

describe('an accepted order is unaffected', () => {
  it('carries no rejection payload', async () => {
    const { svc } = harness(10_000_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    const res = await svc.placeOrder(buy({ qty: 10 }))
    expect(res.accepted).toBe(true)
    expect(res.rejection).toBeUndefined()
  })

  it('still fills and returns trades when it crosses', async () => {
    const { svc } = harness(10_000_000)
    await svc.loadInstruments()
    await svc.startRound(0)
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'sell', type: 'limit', price: 230, qty: 10, leverage: 1 })
    const res = await svc.placeOrder(buy({ qty: 10 }))
    expect(res.accepted).toBe(true)
    expect(res.rejection).toBeUndefined()
    expect(res.trades?.length).toBe(1)
  })
})
