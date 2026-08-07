/**
 * Continuous-auction limit order book with price-time priority.
 *
 * Pure and deterministic, like the rest of the engine: no clock, no RNG, no I/O.
 * Order timestamps are supplied by the caller (they define time priority), and
 * trade ids come from a monotonic per-book counter so a given sequence of
 * placements always produces an identical sequence of trades — replayable and
 * testable.
 *
 * Matching convention: a trade always executes at the RESTING (maker) order's
 * price. The incoming (taker) order may be willing to pay more / accept less,
 * but it trades at the price already advertised on the book.
 */

export type Side = 'buy' | 'sell'
export type OrderType = 'limit' | 'market'
export type OrderStatus = 'active' | 'partially_filled' | 'filled' | 'cancelled'

export interface Order {
  id: string
  userId: string
  instrument: string
  side: Side
  type: OrderType
  /** Limit price. Required for limit orders; ignored (and cleared) for market. */
  price?: number
  /** Original order quantity. */
  qty: number
  /** Quantity still to be filled. */
  remainingQty: number
  status: OrderStatus
  /** Caller-supplied time priority (lower = earlier). */
  timestamp: number
}

export interface Trade {
  id: string
  buyOrderId: string
  sellOrderId: string
  instrument: string
  /** Execution price — always the resting order's price. */
  price: number
  qty: number
  timestamp: number
}

/** One aggregated price level in the depth ladder. */
export interface DepthLevel {
  price: number
  /** TOTAL resting quantity at this price, across every account. */
  qty: number
  /**
   * The portion of `qty` resting under the account `getDepth` was called for.
   *
   * Present only when a viewer was named. It exists because self-trade
   * prevention means a taker can never match its OWN resting orders: that
   * quantity is visible liquidity for everyone else, but not for its owner. A
   * price preview must subtract it or it will promise a fill against the
   * trader's own order. The level is MARKED rather than reduced so the depth
   * ladder can still show traders their own working orders.
   */
  ownQty?: number
}

export interface Depth {
  /** Highest price first. */
  bids: DepthLevel[]
  /** Lowest price first. */
  asks: DepthLevel[]
}

/**
 * Bid ordering (buy side): best = highest price, then earliest timestamp.
 * Returns 0 on a full tie so a *stable* sort preserves insertion order (FIFO)
 * among orders sharing both price and timestamp.
 */
function bidCompare(a: Order, b: Order): number {
  if (a.price !== b.price) return (b.price ?? 0) - (a.price ?? 0)
  return a.timestamp - b.timestamp
}

/** Ask ordering (sell side): best = lowest price, then earliest timestamp. */
function askCompare(a: Order, b: Order): number {
  if (a.price !== b.price) return (a.price ?? 0) - (b.price ?? 0)
  return a.timestamp - b.timestamp
}

export class OrderBook {
  readonly instrument: string
  /** Resting buy limit orders, best (highest price / earliest) first. */
  private bids: Order[] = []
  /** Resting sell limit orders, best (lowest price / earliest) first. */
  private asks: Order[] = []
  private tradeSeq = 0

  constructor(instrument: string) {
    this.instrument = instrument
  }

  /**
   * Place a limit order. Matches against the best opposing prices for as long as
   * the incoming price crosses the spread (walking multiple levels, partial
   * fills allowed); any unfilled remainder rests on the book.
   */
  placeLimitOrder(order: Order): Trade[] {
    if (order.price === undefined || Number.isNaN(order.price)) {
      throw new Error('limit order requires a price')
    }
    if (order.qty <= 0) throw new Error('order qty must be positive')

    order.type = 'limit'
    order.remainingQty = order.qty
    order.status = 'active'

    const trades = this.execute(order, false)

    if (order.remainingQty > 0) {
      // Rest the remainder. It's "active" if untouched, else "partially_filled".
      order.status = order.remainingQty < order.qty ? 'partially_filled' : 'active'
      const side = order.side === 'buy' ? this.bids : this.asks
      side.push(order)
      side.sort(order.side === 'buy' ? bidCompare : askCompare)
    }
    return trades
  }

  /**
   * Place a market order. Matches against the best available prices immediately,
   * walking levels until filled or the book is exhausted. Any unfilled quantity
   * is discarded — market orders never rest.
   */
  placeMarketOrder(order: Order): Trade[] {
    if (order.qty <= 0) throw new Error('order qty must be positive')

    order.type = 'market'
    order.price = undefined
    order.remainingQty = order.qty
    order.status = 'active'

    const trades = this.execute(order, true)

    // No resting remainder: fully filled, partially filled (leftover discarded),
    // or nothing available at all (cancelled).
    order.status =
      order.remainingQty === 0
        ? 'filled'
        : order.remainingQty < order.qty
          ? 'partially_filled'
          : 'cancelled'
    return trades
  }

  /**
   * Cancel a resting (active / partially-filled) order by id. Returns true if an
   * order was found and removed; a filled, market, or unknown order returns false.
   */
  cancelOrder(orderId: string): boolean {
    for (const side of [this.bids, this.asks]) {
      const idx = side.findIndex((o) => o.id === orderId)
      if (idx !== -1) {
        const [removed] = side.splice(idx, 1)
        removed.status = 'cancelled'
        return true
      }
    }
    return false
  }

  /** Look up a currently-resting order by id (undefined once filled/cancelled). */
  getOrder(orderId: string): Order | undefined {
    return this.bids.find((o) => o.id === orderId) ?? this.asks.find((o) => o.id === orderId)
  }

  /**
   * Insert an already-resting order onto the book WITHOUT matching it. This is
   * for rehydration/recovery: restoring active / partially-filled orders after a
   * restart, preserving their remainingQty exactly (placeLimitOrder would reset
   * remainingQty to qty and try to match). Callers must only restore orders that
   * were genuinely resting — a consistent book never holds crossing orders, so
   * skipping the match is correct. Time priority follows the order's timestamp.
   */
  restResting(order: Order): void {
    if (order.type !== 'limit' || order.price === undefined) {
      throw new Error('only resting limit orders can be restored')
    }
    if (order.remainingQty <= 0) throw new Error('cannot restore an order with no remaining quantity')
    const side = order.side === 'buy' ? this.bids : this.asks
    side.push(order)
    side.sort(order.side === 'buy' ? bidCompare : askCompare)
  }

  /**
   * Aggregated depth ladder: quantity summed per price level, bids high→low,
   * asks low→high, excluding any level whose aggregated quantity is zero.
   */
  getDepth(forUserId?: string): Depth {
    return {
      bids: aggregate(this.bids, forUserId).sort((a, b) => b.price - a.price),
      asks: aggregate(this.asks, forUserId).sort((a, b) => a.price - b.price),
    }
  }

  /**
   * Core matcher. Walks the opposing book (already in best-first order) while the
   * taker has quantity left and either (a) it's a market order, or (b) its limit
   * price crosses the resting price. Each fill trades at the resting order's price
   * and emits a Trade.
   *
   * Self-trade prevention (STP): a resting order belonging to the SAME account as
   * the taker is never matched — it is skipped (left untouched on the book) and
   * the taker matches the next-best OTHER-account order instead. If the only
   * crossing liquidity is the taker's own, nothing fills (the limit remainder
   * then rests; a market remainder is discarded), so an account can never trade
   * with itself.
   */
  private execute(taker: Order, isMarket: boolean): Trade[] {
    const trades: Trade[] = []
    const opposing = taker.side === 'buy' ? this.asks : this.bids

    while (taker.remainingQty > 0) {
      // Find the best crossing resting order that is NOT the taker's own account.
      let idx = -1
      for (let i = 0; i < opposing.length; i++) {
        const candidate = opposing[i]
        if (!isMarket) {
          const takerPrice = taker.price as number
          const restingPrice = candidate.price as number
          const crosses = taker.side === 'buy' ? takerPrice >= restingPrice : takerPrice <= restingPrice
          if (!crosses) break // book is best-first; nothing past here crosses either
        }
        if (candidate.userId === taker.userId) continue // STP: skip own resting order
        idx = i
        break
      }
      if (idx === -1) break // no eligible counterparty (only own orders, or no cross)

      const resting = opposing[idx]
      const restingPrice = resting.price as number
      const qty = Math.min(taker.remainingQty, resting.remainingQty)
      trades.push({
        id: `${this.instrument}-t${++this.tradeSeq}`,
        buyOrderId: taker.side === 'buy' ? taker.id : resting.id,
        sellOrderId: taker.side === 'buy' ? resting.id : taker.id,
        instrument: this.instrument,
        price: restingPrice, // resting (maker) price by convention
        qty,
        timestamp: taker.timestamp,
      })

      taker.remainingQty -= qty
      resting.remainingQty -= qty
      resting.status = resting.remainingQty === 0 ? 'filled' : 'partially_filled'
      taker.status = taker.remainingQty === 0 ? 'filled' : 'partially_filled'

      if (resting.remainingQty === 0) opposing.splice(idx, 1)
    }
    return trades
  }
}

/**
 * Sum remaining quantity per price level, dropping empty levels. When `ownerId`
 * is given, each level also reports how much of it belongs to that account.
 */
function aggregate(orders: readonly Order[], ownerId?: string): DepthLevel[] {
  const byPrice = new Map<number, number>()
  const ownByPrice = new Map<number, number>()
  for (const o of orders) {
    const price = o.price as number
    byPrice.set(price, (byPrice.get(price) ?? 0) + o.remainingQty)
    if (ownerId !== undefined && o.userId === ownerId) {
      ownByPrice.set(price, (ownByPrice.get(price) ?? 0) + o.remainingQty)
    }
  }
  const levels: DepthLevel[] = []
  for (const [price, qty] of byPrice) {
    if (qty <= 0) continue
    levels.push(ownerId === undefined ? { price, qty } : { price, qty, ownQty: ownByPrice.get(price) ?? 0 })
  }
  return levels
}

/**
 * Thin multi-instrument router: one OrderBook per instrument, created on demand.
 * Gives the spec's instrument-keyed API (getDepth(instrument), etc.) on top of
 * the per-instrument books. Orders never match across instruments.
 */
export class MatchingEngine {
  private books = new Map<string, OrderBook>()

  private bookFor(instrument: string): OrderBook {
    let book = this.books.get(instrument)
    if (!book) {
      book = new OrderBook(instrument)
      this.books.set(instrument, book)
    }
    return book
  }

  placeLimitOrder(order: Order): Trade[] {
    return this.bookFor(order.instrument).placeLimitOrder(order)
  }

  placeMarketOrder(order: Order): Trade[] {
    return this.bookFor(order.instrument).placeMarketOrder(order)
  }

  cancelOrder(orderId: string): boolean {
    for (const book of this.books.values()) {
      if (book.cancelOrder(orderId)) return true
    }
    return false
  }

  /** Restore an already-resting order onto its instrument's book without matching. */
  restResting(order: Order): void {
    this.bookFor(order.instrument).restResting(order)
  }

  getDepth(instrument: string, forUserId?: string): Depth {
    return this.bookFor(instrument).getDepth(forUserId)
  }
}
