// @vitest-environment node
/**
 * Self-trade prevention, reflected in the depth each account is served.
 *
 * The matcher already refuses to fill a taker against its OWN resting orders.
 * The depth view did not know that: it aggregated every account's quantity into
 * one number, so a trader with an order resting on the far side saw their own
 * liquidity counted as available and got an optimistic price preview for a fill
 * that could never happen.
 *
 * The fix marks each level with the viewer's own share rather than deleting it,
 * so the ladder still shows traders their working orders while the preview can
 * subtract what it cannot trade against. These tests pin both halves: the owner
 * does not get to count their own quantity, and every OTHER account still sees
 * that quantity in full and can genuinely match against it.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const A = 'acct-a'
const B = 'acct-b'
const CASH = 100_000_000 // large, so margin never interferes with these tests

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

const rest = (svc: TradingService, accountId: string, side: 'buy' | 'sell', price: number, qty: number) =>
  svc.placeOrder({ accountId, ticker: 'AAPL', side, type: 'limit', price, qty, leverage: 1 })

/** Depth the given account is served, as the snapshot builds it. */
const asksFor = (svc: TradingService, accountId: string) => svc.depthView('AAPL', false, accountId).asks
const bidsFor = (svc: TradingService, accountId: string) => svc.depthView('AAPL', false, accountId).bids

// ---------------------------------------------------------------------------

describe('an account does not get to count its own resting liquidity', () => {
  it('marks the whole level as its own when it is the only maker', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)

    const [level] = asksFor(svc, A)
    expect(level.price).toBe(210)
    expect(level.qty).toBe(40) // still displayed in full for the ladder
    expect(level.ownQty).toBe(40) // ...but none of it is tradable BY A
    expect(level.qty - (level.ownQty ?? 0)).toBe(0)
  })

  it('marks only its own share when the level is shared with someone else', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)
    await rest(svc, B, 'sell', 210, 60)

    const [level] = asksFor(svc, A)
    expect(level.qty).toBe(100) // A + B aggregated
    expect(level.ownQty).toBe(40)
    expect(level.qty - (level.ownQty ?? 0)).toBe(60) // only B's is tradable by A
  })

  it('accounts for its own quantity across several price levels', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 10)
    await rest(svc, B, 'sell', 211, 20)
    await rest(svc, A, 'sell', 212, 30)

    const own = Object.fromEntries(asksFor(svc, A).map((l) => [l.price, l.ownQty]))
    expect(own).toEqual({ 210: 10, 211: 0, 212: 30 })
  })

  it('applies to the bid side for a seller too', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'buy', 190, 25)
    await rest(svc, B, 'buy', 190, 15)

    const [level] = bidsFor(svc, A)
    expect(level.qty).toBe(40)
    expect(level.ownQty).toBe(25)
  })

  it('shrinks as the account cancels', async () => {
    const { svc } = await harness()
    const placed = await rest(svc, A, 'sell', 210, 40)
    await rest(svc, B, 'sell', 210, 60)
    await svc.cancelOrder(placed.orderId!, { accountId: A, role: 'team' })

    const [level] = asksFor(svc, A)
    expect(level.qty).toBe(60)
    expect(level.ownQty).toBe(0) // A owns none of what is left
  })
})

describe('every OTHER account still sees that liquidity in full', () => {
  it("B sees A's resting order as entirely tradable", async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)

    const [level] = asksFor(svc, B)
    expect(level.qty).toBe(40)
    expect(level.ownQty).toBe(0) // none of it is B's
    expect(level.qty - (level.ownQty ?? 0)).toBe(40) // all of it is B's to take
  })

  it('the two accounts are served genuinely different views of one book', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)
    await rest(svc, B, 'sell', 210, 60)

    const forA = asksFor(svc, A)[0]
    const forB = asksFor(svc, B)[0]
    expect(forA.qty).toBe(forB.qty) // same TOTAL displayed to both
    expect(forA.ownQty).toBe(40)
    expect(forB.ownQty).toBe(60) // ...different tradable shares
  })

  it('and B can actually match against it — the liquidity was real', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)

    const res = await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'market', qty: 40, leverage: 1, markPrice: 210 })
    expect(res.accepted).toBe(true)
    expect(res.trades?.reduce((a, t) => a + t.qty, 0)).toBe(40)
    expect(res.trades?.[0].price).toBe(210)
  })

  it("A genuinely CANNOT match against its own — the preview was right to exclude it", async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)

    // Self-trade prevention: nothing fills, and a market remainder is discarded.
    const res = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'market', qty: 40, leverage: 1, markPrice: 210 })
    expect(res.accepted).toBe(true)
    expect(res.trades ?? []).toHaveLength(0)
  })

  it('A fills only against B when the level is shared', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)
    await rest(svc, B, 'sell', 210, 60)

    // A's tradable depth at 210 was reported as 60 — exactly what fills.
    const tradable = asksFor(svc, A)[0].qty - (asksFor(svc, A)[0].ownQty ?? 0)
    const res = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'market', qty: 100, leverage: 1, markPrice: 210 })
    expect(res.trades?.reduce((a, t) => a + t.qty, 0)).toBe(tradable)
    expect(tradable).toBe(60)
  })
})

describe('the neutral view is unchanged', () => {
  it('omits ownQty entirely when no viewer is named', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)

    const [level] = svc.depthView('AAPL', false).asks
    expect(level.qty).toBe(40)
    expect(level.ownQty).toBeUndefined()
  })

  it('the market maker still receives the per-order list alongside', async () => {
    const { svc } = await harness()
    await rest(svc, A, 'sell', 210, 40)

    const view = svc.depthView('AAPL', true, B)
    expect(view.restingOrders).toHaveLength(1)
    expect(view.restingOrders![0].accountId).toBe(A)
    expect(view.asks[0].ownQty).toBe(0)
  })
})
