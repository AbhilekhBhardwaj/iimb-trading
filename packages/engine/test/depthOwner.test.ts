/**
 * Depth as ONE account can actually trade it.
 *
 * Self-trade prevention means the matcher skips a taker's own resting orders.
 * Aggregated depth used to hide that: one number per price level, summed across
 * every account, so an account with an order resting on the far side saw its
 * own quantity as available liquidity. `getDepth(forUserId)` marks the viewer's
 * share of each level so a caller can discount what it can never fill against.
 *
 * The level is MARKED, not reduced — the depth ladder still needs to show a
 * trader their own working orders.
 */
import { describe, expect, it } from 'vitest'
import { type Order, OrderBook } from '../src/orderbook'

const mk = (
  id: string,
  userId: string,
  side: 'buy' | 'sell',
  price: number,
  qty: number,
): Order => ({
  id,
  userId,
  instrument: 'AAPL',
  side,
  type: 'limit',
  price,
  qty,
  remainingQty: qty,
  status: 'active',
  timestamp: Number(id.slice(1)),
})

describe('getDepth(forUserId)', () => {
  it('reports each account its own share of a shared level', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 40))
    ob.placeLimitOrder(mk('o2', 'bob', 'sell', 210, 60))

    const forAlice = ob.getDepth('alice').asks[0]
    expect(forAlice.qty).toBe(100) // total, unchanged
    expect(forAlice.ownQty).toBe(40)

    const forBob = ob.getDepth('bob').asks[0]
    expect(forBob.qty).toBe(100)
    expect(forBob.ownQty).toBe(60)
  })

  it('reports zero for an account with nothing resting', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 40))
    expect(ob.getDepth('carol').asks[0].ownQty).toBe(0)
  })

  it('omits ownQty entirely when no viewer is named', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 40))
    const level = ob.getDepth().asks[0]
    expect(level.qty).toBe(40)
    expect(level.ownQty).toBeUndefined()
  })

  it('tracks own quantity across separate price levels', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 10))
    ob.placeLimitOrder(mk('o2', 'bob', 'sell', 211, 20))
    ob.placeLimitOrder(mk('o3', 'alice', 'sell', 212, 30))

    expect(ob.getDepth('alice').asks.map((l) => [l.price, l.ownQty])).toEqual([
      [210, 10],
      [211, 0],
      [212, 30],
    ])
  })

  it('works on the bid side', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'buy', 190, 25))
    ob.placeLimitOrder(mk('o2', 'bob', 'buy', 190, 15))
    expect(ob.getDepth('alice').bids[0].ownQty).toBe(25)
  })

  it('follows a partial fill of the viewer own order', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 40))
    ob.placeLimitOrder(mk('o2', 'bob', 'buy', 210, 15)) // takes 15 of alice
    const level = ob.getDepth('alice').asks[0]
    expect(level.qty).toBe(25)
    expect(level.ownQty).toBe(25)
  })
})

describe('the discounted depth is exactly what STP will let that account fill', () => {
  const taker = (userId: string, qty: number): Order => ({
    id: 'taker', userId, instrument: 'AAPL', side: 'buy', type: 'market',
    price: undefined, qty, remainingQty: qty, status: 'active', timestamp: 99,
  })

  it('alice fills only bob quantity, which is exactly what her view reported', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 40))
    ob.placeLimitOrder(mk('o2', 'bob', 'sell', 210, 60))

    const level = ob.getDepth('alice').asks[0]
    const tradable = level.qty - (level.ownQty ?? 0)

    const trades = ob.placeMarketOrder(taker('alice', 100))
    expect(trades.reduce((a, t) => a + t.qty, 0)).toBe(tradable)
    expect(tradable).toBe(60)
  })

  it('a book that is entirely her own fills nothing at all', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 40))

    const level = ob.getDepth('alice').asks[0]
    expect(level.qty - (level.ownQty ?? 0)).toBe(0)
    expect(ob.placeMarketOrder(taker('alice', 40))).toHaveLength(0)
  })

  it('but carol takes the whole level, as her view promised', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(mk('o1', 'alice', 'sell', 210, 40))

    const level = ob.getDepth('carol').asks[0]
    expect(level.qty - (level.ownQty ?? 0)).toBe(40)
    expect(ob.placeMarketOrder(taker('carol', 40)).reduce((a, t) => a + t.qty, 0)).toBe(40)
  })
})
