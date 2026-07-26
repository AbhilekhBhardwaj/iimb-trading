import { describe, it, expect } from 'vitest'
import { MatchingEngine, OrderBook, type Order } from '../src/orderbook'

let idSeq = 0

/** Build an order with sensible defaults; timestamp defaults to a monotonic seq. */
function ord(
  o: Partial<Order> & Pick<Order, 'side' | 'qty'> & { price?: number },
): Order {
  idSeq++
  return {
    id: o.id ?? `o${idSeq}`,
    userId: o.userId ?? 'u1',
    instrument: o.instrument ?? 'AAPL',
    side: o.side,
    type: o.type ?? 'limit',
    price: o.price,
    qty: o.qty,
    remainingQty: o.qty,
    status: 'active',
    timestamp: o.timestamp ?? idSeq,
  }
}

describe('OrderBook — resting & price-time priority', () => {
  it('a limit order that does not cross rests correctly (aggregated, sorted)', () => {
    const book = new OrderBook('AAPL')
    expect(book.placeLimitOrder(ord({ side: 'buy', price: 100, qty: 10, timestamp: 1 }))).toEqual([])
    expect(book.placeLimitOrder(ord({ side: 'buy', price: 100, qty: 5, timestamp: 2 }))).toEqual([])
    expect(book.placeLimitOrder(ord({ side: 'buy', price: 101, qty: 3, timestamp: 3 }))).toEqual([])

    const depth = book.getDepth()
    expect(depth.bids).toEqual([
      { price: 101, qty: 3 }, // best (highest) first
      { price: 100, qty: 15 }, // two orders aggregated
    ])
    expect(depth.asks).toEqual([])
  })

  it('price-time priority: same price, earlier order fills first', () => {
    const book = new OrderBook('AAPL')
    const first = ord({ id: 'A', side: 'sell', price: 100, qty: 5, timestamp: 1 })
    const second = ord({ id: 'B', side: 'sell', price: 100, qty: 5, timestamp: 2 })
    book.placeLimitOrder(first)
    book.placeLimitOrder(second)

    const trades = book.placeLimitOrder(ord({ side: 'buy', price: 100, qty: 5, timestamp: 3 }))
    expect(trades).toHaveLength(1)
    expect(trades[0].sellOrderId).toBe('A') // earlier timestamp filled first
    expect(book.getOrder('A')).toBeUndefined() // A fully consumed
    expect(book.getOrder('B')?.remainingQty).toBe(5) // B still fully resting
  })

  it('price-time priority: equal timestamp falls back to insertion (FIFO) order', () => {
    const book = new OrderBook('AAPL')
    book.placeLimitOrder(ord({ id: 'X', side: 'sell', price: 100, qty: 5, timestamp: 7 }))
    book.placeLimitOrder(ord({ id: 'Y', side: 'sell', price: 100, qty: 5, timestamp: 7 }))
    const trades = book.placeLimitOrder(ord({ side: 'buy', price: 100, qty: 5, timestamp: 8 }))
    expect(trades[0].sellOrderId).toBe('X') // X inserted first
  })
})

describe('OrderBook — limit matching', () => {
  it('a limit order that exactly crosses one resting order fully fills both', () => {
    const book = new OrderBook('AAPL')
    const ask = ord({ id: 'ask', side: 'sell', price: 100, qty: 10, timestamp: 1 })
    book.placeLimitOrder(ask)
    const bid = ord({ id: 'bid', side: 'buy', price: 100, qty: 10, timestamp: 2 })
    const trades = book.placeLimitOrder(bid)

    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({
      buyOrderId: 'bid',
      sellOrderId: 'ask',
      instrument: 'AAPL',
      price: 100,
      qty: 10,
    })
    expect(ask.status).toBe('filled')
    expect(bid.status).toBe('filled')
    expect(book.getDepth()).toEqual({ bids: [], asks: [] })
  })

  it('a limit order that partially fills leaves the remainder resting', () => {
    const book = new OrderBook('AAPL')
    const ask = ord({ id: 'ask', side: 'sell', price: 100, qty: 5, timestamp: 1 })
    book.placeLimitOrder(ask)
    const bid = ord({ id: 'bid', side: 'buy', price: 100, qty: 12, timestamp: 2 })
    const trades = book.placeLimitOrder(bid)

    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ price: 100, qty: 5 })
    expect(ask.status).toBe('filled')
    expect(bid.status).toBe('partially_filled')
    expect(bid.remainingQty).toBe(7)
    expect(book.getDepth()).toEqual({ bids: [{ price: 100, qty: 7 }], asks: [] })
  })

  it('fills against MULTIPLE resting orders across price levels, and uses resting prices', () => {
    const book = new OrderBook('AAPL')
    book.placeLimitOrder(ord({ id: 'a100', side: 'sell', price: 100, qty: 5, timestamp: 1 }))
    book.placeLimitOrder(ord({ id: 'a101', side: 'sell', price: 101, qty: 5, timestamp: 2 }))
    book.placeLimitOrder(ord({ id: 'a102', side: 'sell', price: 102, qty: 5, timestamp: 3 }))

    // Willing to pay up to 101 for 8 units.
    const trades = book.placeLimitOrder(ord({ id: 'buy', side: 'buy', price: 101, qty: 8, timestamp: 4 }))

    expect(trades.map((t) => ({ price: t.price, qty: t.qty }))).toEqual([
      { price: 100, qty: 5 }, // best level first, resting price
      { price: 101, qty: 3 }, // walks to next level, resting price (not 101 taker cap coincidence — see below)
    ])
    expect(book.getDepth().asks).toEqual([
      { price: 101, qty: 2 }, // partially consumed
      { price: 102, qty: 5 }, // never crossed (102 > 101 limit)
    ])
    expect(book.getDepth().bids).toEqual([]) // fully filled, nothing rests
  })

  it("a crossing limit trades at the RESTING price, not the taker's better price", () => {
    const book = new OrderBook('AAPL')
    book.placeLimitOrder(ord({ id: 'ask', side: 'sell', price: 100, qty: 5, timestamp: 1 }))
    // Buyer willing to pay 105, but the resting ask is at 100.
    const trades = book.placeLimitOrder(ord({ id: 'buy', side: 'buy', price: 105, qty: 5, timestamp: 2 }))
    expect(trades[0].price).toBe(100)
  })
})

describe('OrderBook — market matching', () => {
  it('fills against best available prices and walks levels', () => {
    const book = new OrderBook('AAPL')
    book.placeLimitOrder(ord({ id: 'a100', side: 'sell', price: 100, qty: 5, timestamp: 1 }))
    book.placeLimitOrder(ord({ id: 'a101', side: 'sell', price: 101, qty: 5, timestamp: 2 }))

    const mkt = ord({ id: 'm', side: 'buy', type: 'market', qty: 8, timestamp: 3 })
    const trades = book.placeMarketOrder(mkt)

    expect(trades.map((t) => ({ price: t.price, qty: t.qty }))).toEqual([
      { price: 100, qty: 5 },
      { price: 101, qty: 3 },
    ])
    expect(mkt.status).toBe('filled')
    expect(book.getDepth().asks).toEqual([{ price: 101, qty: 2 }])
    expect(book.getDepth().bids).toEqual([]) // market never rests
  })

  it('with insufficient liquidity fills what it can and leaves NO resting remainder', () => {
    const book = new OrderBook('AAPL')
    book.placeLimitOrder(ord({ id: 'ask', side: 'sell', price: 100, qty: 5, timestamp: 1 }))

    const mkt = ord({ id: 'm', side: 'buy', type: 'market', qty: 10, timestamp: 2 })
    const trades = book.placeMarketOrder(mkt)

    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ price: 100, qty: 5 })
    expect(mkt.remainingQty).toBe(5)
    expect(mkt.status).toBe('partially_filled')
    // Nothing rests: the ask is consumed and the market remainder is discarded.
    expect(book.getDepth()).toEqual({ bids: [], asks: [] })
  })

  it('against an empty book produces no trades and does not rest', () => {
    const book = new OrderBook('AAPL')
    const mkt = ord({ id: 'm', side: 'sell', type: 'market', qty: 5, timestamp: 1 })
    const trades = book.placeMarketOrder(mkt)
    expect(trades).toEqual([])
    expect(mkt.status).toBe('cancelled')
    expect(mkt.remainingQty).toBe(5)
    expect(book.getDepth()).toEqual({ bids: [], asks: [] })
  })
})

describe('OrderBook — cancel & depth', () => {
  it('cancelling removes an order so it can no longer be matched', () => {
    const book = new OrderBook('AAPL')
    const ask = ord({ id: 'ask', side: 'sell', price: 100, qty: 5, timestamp: 1 })
    book.placeLimitOrder(ask)

    expect(book.cancelOrder('ask')).toBe(true)
    expect(ask.status).toBe('cancelled')
    expect(book.getDepth().asks).toEqual([])

    // A crossing buy now finds nothing to match and simply rests.
    const buy = ord({ id: 'buy', side: 'buy', price: 100, qty: 5, timestamp: 2 })
    const trades = book.placeLimitOrder(buy)
    expect(trades).toEqual([])
    expect(book.getDepth().bids).toEqual([{ price: 100, qty: 5 }])

    // Cancelling something unknown / already-gone returns false.
    expect(book.cancelOrder('ask')).toBe(false)
    expect(book.cancelOrder('nope')).toBe(false)
  })

  it('getDepth aggregates per level and excludes emptied levels', () => {
    const book = new OrderBook('AAPL')
    book.placeLimitOrder(ord({ side: 'buy', price: 100, qty: 6, timestamp: 1 }))
    book.placeLimitOrder(ord({ side: 'buy', price: 100, qty: 4, timestamp: 2 }))
    book.placeLimitOrder(ord({ side: 'buy', price: 99, qty: 5, timestamp: 3 }))
    book.placeLimitOrder(ord({ side: 'sell', price: 101, qty: 3, timestamp: 4 }))

    expect(book.getDepth()).toEqual({
      bids: [
        { price: 100, qty: 10 },
        { price: 99, qty: 5 },
      ],
      asks: [{ price: 101, qty: 3 }],
    })

    // Consume the entire 100 level; it must disappear from the ladder.
    book.placeLimitOrder(ord({ side: 'sell', price: 100, qty: 10, timestamp: 5 }))
    expect(book.getDepth().bids).toEqual([{ price: 99, qty: 5 }])
  })
})

describe('MatchingEngine — instrument routing', () => {
  it('routes by instrument, exposes getDepth(instrument), and never matches across instruments', () => {
    const eng = new MatchingEngine()
    eng.placeLimitOrder(ord({ id: 'aapl-bid', instrument: 'AAPL', side: 'buy', price: 100, qty: 5, timestamp: 1 }))
    eng.placeLimitOrder(ord({ id: 'tsla-bid', instrument: 'TSLA', side: 'buy', price: 200, qty: 3, timestamp: 2 }))

    expect(eng.getDepth('AAPL').bids).toEqual([{ price: 100, qty: 5 }])
    expect(eng.getDepth('TSLA').bids).toEqual([{ price: 200, qty: 3 }])

    // A TSLA sell at 100 must NOT hit the AAPL bid at 100.
    const trades = eng.placeLimitOrder(
      ord({ id: 'tsla-ask', instrument: 'TSLA', side: 'sell', price: 100, qty: 3, timestamp: 3 }),
    )
    expect(trades).toHaveLength(1)
    expect(trades[0]).toMatchObject({ instrument: 'TSLA', buyOrderId: 'tsla-bid', price: 200, qty: 3 })
    expect(eng.getDepth('AAPL').bids).toEqual([{ price: 100, qty: 5 }]) // untouched

    expect(eng.cancelOrder('aapl-bid')).toBe(true)
    expect(eng.getDepth('AAPL').bids).toEqual([])
  })
})
