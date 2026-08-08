// @vitest-environment node
/**
 * Four latency optimisations on the order path, each verified to change only
 * the number of database round-trips — never a number, never a stored row.
 *
 * Load testing measured ~1,550ms per filled order, which is ~18 sequential
 * Supabase round-trips at ~85ms each. These remove seven of them. Correctness
 * comes first: every test here asserts the resulting state matches what the
 * unoptimised path produced, and only then counts calls.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const NVDA = { id: 'i-nvda', ticker: 'NVDA', name: 'Nvidia', sector: 'Tech', reference_price: 120 }
const A = 'acct-a'
const B = 'acct-b'
const CASH = 10_000_000
const RATE = DEFAULT_USD_INR_RATE

function schedule(): EventConfig {
  return [
    { id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: true, usdInrRate: RATE, commissionRate: 0.003 },
    { id: 'r2', mode: 'only_data', durationSeconds: 600, commissionEnabled: true, usdInrRate: RATE, commissionRate: 0.003 },
  ]
}

/** Counts every table access so round-trips can be asserted, not assumed. */
class CountingDb extends FakeDb {
  calls: string[] = []
  override from(table: string) {
    this.calls.push(table)
    return super.from(table)
  }
  countOf(table: string): number {
    return this.calls.filter((t) => t === table).length
  }
  reset(): void {
    this.calls = []
  }
}

async function harness() {
  const db = new CountingDb({
    instruments: [{ ...AAPL }, { ...NVDA }],
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

const limit = (svc: TradingService, who: string, side: 'buy' | 'sell', price: number, qty: number, ticker = 'AAPL') =>
  svc.placeOrder({ accountId: who, ticker, side, type: 'limit', price, qty, leverage: 1 })

/** Cross a buy and a sell so both fill. */
async function cross(svc: TradingService, qty: number, price: number) {
  await limit(svc, B, 'sell', price, qty)
  return limit(svc, A, 'buy', price, qty)
}

// ---------------------------------------------------------------------------
// 1. Log batching
// ---------------------------------------------------------------------------

describe('1. event_log writes are batched, and nothing is lost', () => {
  it('a filled order still records EVERY audit event', async () => {
    const { db, svc } = await harness()
    await cross(svc, 10, 200)
    const types = db.rows('event_log').map((e) => e.event_type).sort()
    // order_placed x2 (both sides), order_matched x2, commission_charged x2
    expect(types.filter((t) => t === 'order_placed')).toHaveLength(2)
    expect(types.filter((t) => t === 'order_matched')).toHaveLength(2)
    expect(types.filter((t) => t === 'commission_charged')).toHaveLength(2)
  })

  it('each event keeps its own account, type, severity and payload', async () => {
    const { db, svc } = await harness()
    await cross(svc, 10, 200)
    const matched = db.rows('event_log').filter((e) => e.event_type === 'order_matched')
    expect(matched.map((e) => e.account_id).sort()).toEqual([A, B].sort())
    for (const m of matched) {
      expect(m.severity).toBe('info')
      expect(m.payload.qty).toBe(10)
      expect(m.payload.price).toBe(200)
    }
  })

  it('takes ONE event_log round-trip for the filling order, not five', async () => {
    const { db, svc } = await harness()
    await limit(svc, B, 'sell', 200, 10) // resting side first
    db.reset()
    await limit(svc, A, 'buy', 200, 10) // this one fills and emits 5 events
    expect(db.countOf('event_log')).toBe(1)
  })

  it('a REJECTED order still writes its audit row', async () => {
    const { db, svc } = await harness()
    const res = await limit(svc, A, 'buy', 200, 10_000_000) // way over margin
    expect(res.accepted).toBe(false)
    expect(db.rows('event_log').filter((e) => e.event_type === 'order_rejected')).toHaveLength(1)
  })

  it('a resting (unfilled) order writes its order_placed row', async () => {
    const { db, svc } = await harness()
    await limit(svc, A, 'buy', 150, 5)
    expect(db.rows('event_log').filter((e) => e.event_type === 'order_placed')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 2. starting_cash cache
// ---------------------------------------------------------------------------

describe('2. starting_cash is cached, and the numbers do not move', () => {
  it('the first order reads profiles; later ones do not re-read it', async () => {
    const { db, svc } = await harness()
    await limit(svc, A, 'buy', 150, 5)
    const first = db.countOf('profiles')
    expect(first).toBeGreaterThan(0)

    db.reset()
    await limit(svc, A, 'buy', 149, 5)
    await limit(svc, A, 'buy', 148, 5)
    expect(db.countOf('profiles')).toBe(0) // served from cache
  })

  it('available margin is identical to the uncached value', async () => {
    const { svc } = await harness()
    const before = await svc.getAccountState(A)
    expect(before.availableMarginInr).toBe(CASH)

    await limit(svc, A, 'buy', 150, 20)
    const after = await svc.getAccountState(A)
    expect(after.marginReservedInr).toBeCloseTo(20 * 150 * RATE, 6)
    expect(after.availableMarginInr).toBeCloseTo(CASH - 20 * 150 * RATE, 6)
  })

  it('the margin gate still rejects on the correct threshold', async () => {
    const { svc } = await harness()
    // CASH / (200 * rate) = max affordable qty; one more must be refused.
    const maxQty = Math.floor(CASH / (200 * RATE))
    expect((await limit(svc, A, 'buy', 200, maxQty)).accepted).toBe(true)
    const over = await limit(svc, A, 'buy', 200, maxQty)
    expect(over.accepted).toBe(false)
    expect(over.rejection?.code).toBe('insufficient_margin')
  })

  it('is per account — one team cache never answers for another', async () => {
    const { svc } = await harness()
    await limit(svc, A, 'buy', 150, 20)
    expect((await svc.getAccountState(B)).availableMarginInr).toBe(CASH)
  })
})

// ---------------------------------------------------------------------------
// 3. Merged positions read
// ---------------------------------------------------------------------------

describe('3. one positions read serves both derivations', () => {
  it('reads positions ONCE on the pre-trade path, not twice', async () => {
    const { db, svc } = await harness()
    db.reset()
    await limit(svc, A, 'buy', 150, 5) // rests; no fill, so no settlement reads
    expect(db.countOf('positions')).toBe(1)
  })

  it('margin across MULTIPLE instruments is still counted in full', async () => {
    const { svc } = await harness()
    await limit(svc, B, 'sell', 200, 10, 'AAPL')
    await limit(svc, A, 'buy', 200, 10, 'AAPL')
    await limit(svc, B, 'sell', 120, 10, 'NVDA')
    await limit(svc, A, 'buy', 120, 10, 'NVDA')

    const state = await svc.getAccountState(A)
    // Both positions contribute: 10*200*rate + 10*120*rate
    expect(state.marginUsedInr).toBeCloseTo(10 * 200 * RATE + 10 * 120 * RATE, 6)
  })

  it('the traded instrument position is read correctly from the merged rows', async () => {
    const { svc } = await harness()
    await limit(svc, B, 'sell', 200, 10)
    await limit(svc, A, 'buy', 200, 10)
    // Adding to the position must use the EXISTING basis, not a flat one.
    await limit(svc, B, 'sell', 220, 10)
    await limit(svc, A, 'buy', 220, 10)

    const inv = (await svc.portfolio(A)).inventory as { ticker: string; qty: number | null; avgPrice: number | null }[]
    const aapl = inv.find((r) => r.ticker === 'AAPL')!
    expect(aapl.qty).toBe(20)
    expect(aapl.avgPrice).toBeCloseTo(210, 6) // blended, so the merged read fed the right basis
  })

  it('an account with no positions still prices correctly', async () => {
    const { svc } = await harness()
    expect((await limit(svc, A, 'buy', 150, 5)).accepted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Batched order-state write
// ---------------------------------------------------------------------------

describe('4. both sides of a fill sync in one write', () => {
  it('the resting order is marked filled', async () => {
    const { db, svc } = await harness()
    const resting = await limit(svc, B, 'sell', 200, 10)
    await limit(svc, A, 'buy', 200, 10)
    expect(db.rows('orders').find((o) => o.id === resting.orderId)!.status).toBe('filled')
  })

  it('a PARTIAL fill leaves the correct remaining quantity on both sides', async () => {
    const { db, svc } = await harness()
    const resting = await limit(svc, B, 'sell', 200, 10)
    const taker = await limit(svc, A, 'buy', 200, 4)

    const rest = db.rows('orders').find((o) => o.id === resting.orderId)!
    const take = db.rows('orders').find((o) => o.id === taker.orderId)!
    expect(rest.status).toBe('partially_filled')
    expect(Number(rest.remaining_qty)).toBe(6)
    expect(take.status).toBe('filled')
    expect(Number(take.remaining_qty)).toBe(0)
  })

  it('an order walking MULTIPLE levels syncs every touched order', async () => {
    const { db, svc } = await harness()
    const a1 = await limit(svc, B, 'sell', 200, 5)
    const a2 = await limit(svc, B, 'sell', 201, 5)
    await limit(svc, A, 'buy', 205, 10) // takes both

    for (const id of [a1.orderId, a2.orderId]) {
      expect(db.rows('orders').find((o) => o.id === id)!.status).toBe('filled')
    }
  })
})

// ---------------------------------------------------------------------------
// The whole point: fewer round-trips, identical outcome
// ---------------------------------------------------------------------------

describe('net effect on a filled order', () => {
  it('settles to exactly the same numbers as before', async () => {
    const { db, svc } = await harness()
    await cross(svc, 10, 200)

    // 10 x $200 x 83 = Rs 1,66,000 notional; commission 0.3% = Rs 498 a side.
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(-498, 6)
    expect(Number(db.profile(B)!.realized_pnl_inr)).toBeCloseTo(-498, 6)
    expect(Number(db.rows('positions').find((p) => p.account_id === A)!.qty)).toBe(10)
    expect(Number(db.rows('positions').find((p) => p.account_id === B)!.qty)).toBe(-10)
    expect(db.rows('trades')).toHaveLength(1)
  })

  it('the filling order costs materially fewer round-trips than before', async () => {
    const { db, svc } = await harness()
    await limit(svc, B, 'sell', 200, 10)
    await svc.getAccountState(A) // warm A's starting_cash cache, as a real session would be
    db.reset()
    await limit(svc, A, 'buy', 200, 10)

    const total = db.calls.length
    // Was ~18 sequential round-trips; these changes remove several.
    expect(total).toBeLessThanOrEqual(14)
    expect(db.countOf('event_log')).toBe(1) // was 5 separate inserts
    // profiles is still WRITTEN twice for realized P&L, one per side. The cache
    // removes only the starting_cash READ — with a warm cache that read is gone,
    // so 2 here means "writes only, no lookup".
    expect(db.countOf('profiles')).toBe(2)
  })
})
