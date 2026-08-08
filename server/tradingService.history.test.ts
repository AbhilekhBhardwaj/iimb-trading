// @vitest-environment node
/**
 * Trade History must be live: the very next portfolio() read after a closing
 * fill has to contain it, with no refresh, no second poll, no warm-up.
 *
 * The Portfolio page polls portfolio() every 2s and re-reads it immediately
 * after any action, so if the server returns the closed trade synchronously the
 * page cannot be more than 2s stale. These tests pin the server half of that
 * claim; anything still lagging afterwards is transport, not data.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 200 }
const A = 'acct-a'
const B = 'acct-b'
const CASH = 100_000_000

function schedule(): EventConfig {
  return [{ id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: true, usdInrRate: DEFAULT_USD_INR_RATE, commissionRate: 0.003 }]
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

type Hist = { ticker: string; qty: number; grossPnlInr: number; realizedPnlInr: number; side: string }[]
const history = async (svc: TradingService, id: string) =>
  (await svc.portfolio(id)).tradeHistory as Hist

/** Cross a buy and a sell at `price` so both sides fill. */
async function cross(svc: TradingService, buyer: string, seller: string, qty: number, price: number, type: 'limit' | 'market' = 'limit') {
  await svc.placeOrder({ accountId: seller, ticker: 'AAPL', side: 'sell', type: 'limit', price, qty, leverage: 1 })
  return svc.placeOrder({
    accountId: buyer, ticker: 'AAPL', side: 'buy',
    type, price: type === 'limit' ? price : undefined, qty, leverage: 1, markPrice: price,
  })
}

// ---------------------------------------------------------------------------

describe('a closed trade appears in the VERY NEXT portfolio read', () => {
  it('is empty before anything closes', async () => {
    const { svc } = await harness()
    expect(await history(svc, A)).toEqual([])
  })

  it('an OPENING fill alone realizes nothing, so history stays empty', async () => {
    const { svc } = await harness()
    await cross(svc, A, B, 10, 200)
    expect(await history(svc, A)).toEqual([]) // open only — nothing realized yet
  })

  it('the closing fill shows up immediately, with no second poll', async () => {
    const { svc } = await harness()
    await cross(svc, A, B, 10, 200) // A opens long 10 @ 200
    // A closes by selling into B's bid.
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 210, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'sell', type: 'limit', price: 210, qty: 10, leverage: 1 })

    const h = await history(svc, A)
    expect(h).toHaveLength(1)
    expect(h[0].ticker).toBe('AAPL')
    expect(h[0].qty).toBe(10)
    expect(h[0].grossPnlInr).toBeCloseTo(10 * 10 * DEFAULT_USD_INR_RATE, 6) // (210−200) × 10 × rate
  })

  it('a MARKET close appears just as immediately as a limit one', async () => {
    const { svc } = await harness()
    await cross(svc, A, B, 10, 200)
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 210, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'sell', type: 'market', qty: 10, leverage: 1, markPrice: 210 })

    const h = await history(svc, A)
    expect(h).toHaveLength(1)
    expect(h[0].qty).toBe(10)
  })

  it('the COUNTERPARTY sees it in their next read too', async () => {
    const { svc } = await harness()
    // B opens short 10 @ 200 (as the seller), then buys back at 210.
    await cross(svc, A, B, 10, 200)
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 210, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'sell', type: 'limit', price: 210, qty: 10, leverage: 1 })

    const hb = await history(svc, B)
    expect(hb).toHaveLength(1)
    expect(hb[0].side).toBe('short')
    expect(hb[0].grossPnlInr).toBeCloseTo(-10 * 10 * DEFAULT_USD_INR_RATE, 6) // B lost what A made
  })

  it('successive closes each land on their own next read — no batching', async () => {
    const { svc } = await harness()
    await cross(svc, A, B, 20, 200)

    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 210, qty: 5, leverage: 1 })
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'sell', type: 'limit', price: 210, qty: 5, leverage: 1 })
    expect(await history(svc, A)).toHaveLength(1)

    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 215, qty: 5, leverage: 1 })
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'sell', type: 'limit', price: 215, qty: 5, leverage: 1 })
    expect(await history(svc, A)).toHaveLength(2)
  })

  it('repeated reads are stable — no first-call warm-up', async () => {
    const { svc } = await harness()
    await cross(svc, A, B, 10, 200)
    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 210, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'sell', type: 'limit', price: 210, qty: 10, leverage: 1 })

    const first = await history(svc, A)
    const second = await history(svc, A)
    const third = await history(svc, A)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(first).toHaveLength(1)
  })

  it('charges move in the same read as the history row', async () => {
    const { svc } = await harness()
    await cross(svc, A, B, 10, 200)
    const beforeCharges = (await svc.portfolio(A)).chargesInr as number

    await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'buy', type: 'limit', price: 210, qty: 10, leverage: 1 })
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'sell', type: 'limit', price: 210, qty: 10, leverage: 1 })

    const after = await svc.portfolio(A)
    expect(after.chargesInr as number).toBeGreaterThan(beforeCharges)
    expect(after.tradeHistory as Hist).toHaveLength(1)
  })
})
