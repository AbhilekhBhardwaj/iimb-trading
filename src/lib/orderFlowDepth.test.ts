/**
 * Size-aware preview pricing: walking the book instead of quoting one level.
 *
 * The headline test here is the last block — it builds a book in the REAL
 * matching engine, estimates from the depth a client would receive, then
 * submits an actual market order and compares. That is the only way to be sure
 * the preview and the matcher agree rather than merely looking similar.
 */
import { type CashPosition, DEFAULT_COMMISSION_RATE, type Order, OrderBook } from '@iimb-trading/engine'
import { describe, expect, it } from 'vitest'
import { buildConfirmLines, estimateFill, type MarketContext, type OrderTerms, previewPrice } from './orderFlow'
import { averageFillPrice } from './slippage'

const RATE = 83
const LONG: CashPosition = { qty: 10, avgPrice: 180, notionalBasisInr: 149_400, leverage: 1 }

const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({
  position: LONG,
  usdInrRate: RATE,
  commission: { enabled: true, rate: DEFAULT_COMMISSION_RATE },
  slippageEnabled: true,
  ...over,
})

const order = (over: Partial<OrderTerms> = {}): OrderTerms => ({
  ticker: 'AAPL', side: 'sell', type: 'market', qty: 10, price: 190,
  leverage: 1, requiredInr: -1, liq: null, closes: true, ...over,
})

const valueOf = (lines: { k: string; v: string }[], k: string) => lines.find((l) => l.k === k)?.v

// ---------------------------------------------------------------------------

describe('estimateFill — walking the book the way the matcher does', () => {
  /** Asks 30@190, 60@191, 40@193 (130 visible). Bids 25@186, 50@185, 100@180. */
  const book = {
    bids: [{ price: 186, qty: 25 }, { price: 185, qty: 50 }, { price: 180, qty: 100 }],
    asks: [{ price: 190, qty: 30 }, { price: 191, qty: 60 }, { price: 193, qty: 40 }],
  }

  it('a SMALL order that fits the top level prices at that single price', () => {
    const e = estimateFill(book, 'buy', 10)!
    expect(e.avgPrice).toBe(190)
    expect(e.levelsTouched).toBe(1)
    expect(e.partial).toBe(false)
  })

  it('an order exactly exhausting the top level still touches only that level', () => {
    const e = estimateFill(book, 'buy', 30)!
    expect(e.avgPrice).toBe(190)
    expect(e.levelsTouched).toBe(1)
  })

  it('a LARGE order blends across the levels it walks', () => {
    // 30@190 + 20@191 = 5,700 + 3,820 = 9,520 over 50 → 190.40
    const e = estimateFill(book, 'buy', 50)!
    expect(e.avgPrice).toBeCloseTo(190.4, 10)
    expect(e.levelsTouched).toBe(2)
    expect(e.fillableQty).toBe(50)
  })

  it('walks three levels when the order is big enough', () => {
    // 30@190 + 60@191 + 10@193 = 5,700 + 11,460 + 1,930 = 19,090 over 100 → 190.90
    const e = estimateFill(book, 'buy', 100)!
    expect(e.avgPrice).toBeCloseTo(190.9, 10)
    expect(e.levelsTouched).toBe(3)
  })

  it('a SELL walks the bids downward', () => {
    // 25@186 + 25@185 = 4,650 + 4,625 = 9,275 over 50 → 185.50
    const e = estimateFill(book, 'sell', 50)!
    expect(e.avgPrice).toBeCloseTo(185.5, 10)
    expect(e.levelsTouched).toBe(2)
  })

  it('the blended price is always WORSE than top-of-book once it walks', () => {
    expect(estimateFill(book, 'buy', 100)!.avgPrice).toBeGreaterThan(190)
    expect(estimateFill(book, 'sell', 100)!.avgPrice).toBeLessThan(186)
  })

  it('reports a partial when the book cannot fill the whole order', () => {
    const e = estimateFill(book, 'buy', 500)!
    expect(e.partial).toBe(true)
    expect(e.fillableQty).toBe(130) // all the visible depth, not 500
  })

  it('sorts a book handed over out of order', () => {
    const messy = { bids: [], asks: [{ price: 193, qty: 40 }, { price: 190, qty: 30 }, { price: 191, qty: 60 }] }
    expect(estimateFill(messy, 'buy', 30)!.avgPrice).toBe(190)
  })

  it('skips junk levels rather than blending them in', () => {
    const junk = { bids: [], asks: [{ price: 0, qty: 10 }, { price: 190, qty: 30 }, { price: -5, qty: 10 }] }
    expect(estimateFill(junk, 'buy', 10)!.avgPrice).toBe(190)
  })

  it('returns null when the side is empty or the quantity is unusable', () => {
    expect(estimateFill({ bids: [], asks: [] }, 'buy', 10)).toBeNull()
    expect(estimateFill(book, 'buy', 0)).toBeNull()
    expect(estimateFill(book, 'buy', Number.NaN)).toBeNull()
    expect(estimateFill(null, 'buy', 10)).toBeNull()
  })
})

describe('the estimate matches what the REAL matching engine produces', () => {
  const resting = (id: string, side: 'buy' | 'sell', price: number, qty: number, userId: string): Order => ({
    id, userId, instrument: 'AAPL', side, type: 'limit', price, qty, remainingQty: qty,
    status: 'active', timestamp: Number(id.slice(1)),
  })
  const taker = (qty: number, side: 'buy' | 'sell'): Order => ({
    id: 'taker', userId: 'taker', instrument: 'AAPL', side, type: 'market',
    price: undefined, qty, remainingQty: qty, status: 'active', timestamp: 999,
  })
  function askBook(levels: [number, number][]): OrderBook {
    const ob = new OrderBook('AAPL')
    levels.forEach(([price, qty], i) => ob.placeLimitOrder(resting(`o${i + 1}`, 'sell', price, qty, 'maker')))
    return ob
  }

  it('agrees on a single-level fill', () => {
    const ob = askBook([[190, 30], [191, 60]])
    const est = estimateFill(ob.getDepth(), 'buy', 10)!
    const trades = ob.placeMarketOrder(taker(10, 'buy'))
    expect(est.avgPrice).toBeCloseTo(averageFillPrice(trades)!.avgFillPrice, 10)
  })

  it('agrees on a two-level walk', () => {
    const ob = askBook([[190, 30], [191, 60]])
    const est = estimateFill(ob.getDepth(), 'buy', 50)!
    const trades = ob.placeMarketOrder(taker(50, 'buy'))
    const actual = averageFillPrice(trades)!
    expect(est.avgPrice).toBeCloseTo(actual.avgFillPrice, 10)
    expect(est.fillableQty).toBe(actual.filledQty)
  })

  it('agrees on a three-level walk', () => {
    const ob = askBook([[190, 30], [191, 60], [193, 40]])
    const est = estimateFill(ob.getDepth(), 'buy', 100)!
    const trades = ob.placeMarketOrder(taker(100, 'buy'))
    expect(est.avgPrice).toBeCloseTo(averageFillPrice(trades)!.avgFillPrice, 10)
  })

  it('agrees on the SELL side', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(resting('o1', 'buy', 186, 25, 'maker'))
    ob.placeLimitOrder(resting('o2', 'buy', 185, 50, 'maker'))
    const est = estimateFill(ob.getDepth(), 'sell', 50)!
    const trades = ob.placeMarketOrder(taker(50, 'sell'))
    expect(est.avgPrice).toBeCloseTo(averageFillPrice(trades)!.avgFillPrice, 10)
  })

  it('agrees on the fillable quantity when the book runs out', () => {
    const ob = askBook([[190, 30], [191, 20]])
    const est = estimateFill(ob.getDepth(), 'buy', 500)!
    const trades = ob.placeMarketOrder(taker(500, 'buy'))
    const actual = averageFillPrice(trades)!
    expect(est.fillableQty).toBe(actual.filledQty) // 50, not 500
    expect(est.partial).toBe(true)
    expect(est.avgPrice).toBeCloseTo(actual.avgFillPrice, 10)
  })

  it('a level made of several makers fills the same way it aggregates', () => {
    const ob = new OrderBook('AAPL')
    ob.placeLimitOrder(resting('o1', 'sell', 190, 10, 'makerA'))
    ob.placeLimitOrder(resting('o2', 'sell', 190, 20, 'makerB'))
    ob.placeLimitOrder(resting('o3', 'sell', 191, 60, 'makerA'))
    const est = estimateFill(ob.getDepth(), 'buy', 50)!
    const trades = ob.placeMarketOrder(taker(50, 'buy'))
    expect(est.avgPrice).toBeCloseTo(averageFillPrice(trades)!.avgFillPrice, 10)
  })
})

describe('the preview P&L reflects the walked price, not just the top level', () => {
  const book = {
    bids: [{ price: 186, qty: 10 }, { price: 182, qty: 40 }, { price: 178, qty: 100 }],
    asks: [{ price: 190, qty: 10 }, { price: 195, qty: 100 }],
  }
  const px = (side: 'buy' | 'sell', qty: number) =>
    previewPrice({ type: 'market', side, limitPrice: Number.NaN, qty, depth: book, ltp: 180 })

  it('a 10-lot close fits the top bid and previews the full gain', () => {
    const lines = buildConfirmLines(order({ qty: 10, price: px('sell', 10) }), ctx())
    expect(valueOf(lines, 'Price')).toBe('~$186.00 at execution')
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹4,980')
  })

  it('a 50-lot close walks into worse bids, shrinking the gain by more than half', () => {
    // 10@186 + 40@182 = 1,860 + 7,280 = 9,140 over 50 → 182.80
    const walked = px('sell', 50)
    expect(walked).toBeCloseTo(182.8, 10)
    const lines = buildConfirmLines(order({ qty: 50, price: walked }), ctx({
      position: { qty: 50, avgPrice: 180, notionalBasisInr: 747_000, leverage: 1 },
    }))
    // (182.80 − 180) × 50 × 83 = ₹11,620, against ₹24,900 if priced at the top bid.
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹11,620')
  })

  it('a 100-lot close walks deep enough to erase most of the gain', () => {
    // 10@186 + 40@182 + 50@178 = 1,860 + 7,280 + 8,900 = 18,040 over 100 → 180.40
    expect(px('sell', 100)).toBeCloseTo(180.4, 10)
    expect(px('sell', 100)).toBeLessThan(186) // the optimism top-of-book carried
  })

  it('margin on a big BUY reflects the blended ask, not the top ask', () => {
    // 10@190 + 40@195 = 1,900 + 7,800 = 9,700 over 50 → 194.00
    expect(px('buy', 50)).toBeCloseTo(194, 10)
    const lines = buildConfirmLines(
      order({ side: 'buy', qty: 50, price: px('buy', 50), leverage: 5, requiredInr: (50 * 194 * RATE) / 5, closes: false, liq: 155 }),
      ctx({ position: null }),
    )
    expect(valueOf(lines, 'Margin Required')).toBe('₹1,61,020') // 50 × 194 × 83 ÷ 5
  })

  it('falls back to top-of-book while the Qty field is still blank', () => {
    expect(previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: Number.NaN, depth: book, ltp: 180 })).toBe(190)
  })

  it('a LIMIT order is untouched by any of this', () => {
    expect(previewPrice({ type: 'limit', side: 'sell', limitPrice: 175, qty: 500, depth: book, ltp: 180 })).toBe(175)
  })
})

describe('own resting liquidity is discounted from the estimate', () => {
  /**
   * 30 @ 190 of which 20 is the viewer's own, then 60 @ 191 all somebody
   * else's. Self-trade prevention means only 10 of the top level is reachable.
   */
  const book = {
    bids: [],
    asks: [
      { price: 190, qty: 30, ownQty: 20 },
      { price: 191, qty: 60, ownQty: 0 },
    ],
  }

  it('a small order still fills at the top price using the tradable remainder', () => {
    expect(estimateFill(book, 'buy', 10)!.avgPrice).toBe(190)
    expect(estimateFill(book, 'buy', 10)!.levelsTouched).toBe(1)
  })

  it('walks past its own quantity into the next level', () => {
    // Only 10 available at 190, so 20 comes from 191:
    // 10*190 + 20*191 = 1,900 + 3,820 = 5,720 over 30 -> 190.6667
    const e = estimateFill(book, 'buy', 30)!
    expect(e.avgPrice).toBeCloseTo(5720 / 30, 10)
    expect(e.levelsTouched).toBe(2)
  })

  it('is strictly worse than the same book without the own-order discount', () => {
    const naive = { bids: [], asks: [{ price: 190, qty: 30 }, { price: 191, qty: 60 }] }
    expect(estimateFill(book, 'buy', 30)!.avgPrice).toBeGreaterThan(estimateFill(naive, 'buy', 30)!.avgPrice)
  })

  it('a level that is ENTIRELY its own contributes nothing', () => {
    const allMine = { bids: [], asks: [{ price: 190, qty: 30, ownQty: 30 }, { price: 191, qty: 60, ownQty: 0 }] }
    const e = estimateFill(allMine, 'buy', 10)!
    expect(e.avgPrice).toBe(191) // the 190 level is invisible to this account
    expect(e.levelsTouched).toBe(1)
  })

  it('a book made up ENTIRELY of its own orders offers nothing at all', () => {
    const onlyMine = { bids: [], asks: [{ price: 190, qty: 30, ownQty: 30 }] }
    expect(estimateFill(onlyMine, 'buy', 10)).toBeNull()
  })

  it('reduces the fillable quantity, not just the price', () => {
    const e = estimateFill(book, 'buy', 500)!
    expect(e.fillableQty).toBe(70) // 10 tradable + 60, not 90
    expect(e.partial).toBe(true)
  })

  it('other accounts, which carry ownQty 0, are unaffected', () => {
    const asOther = { bids: [], asks: [{ price: 190, qty: 30, ownQty: 0 }, { price: 191, qty: 60, ownQty: 0 }] }
    expect(estimateFill(asOther, 'buy', 30)!.avgPrice).toBe(190)
  })

  it('a view with no ownQty at all behaves exactly as before', () => {
    const neutral = { bids: [], asks: [{ price: 190, qty: 30 }, { price: 191, qty: 60 }] }
    expect(estimateFill(neutral, 'buy', 30)!.avgPrice).toBe(190)
  })

  it('the preview price a trader sees reflects the discount', () => {
    const walked = previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: 30, depth: book, ltp: 180 })
    expect(walked).toBeCloseTo(5720 / 30, 10)
  })
})

describe('partial fill: the preview is measured on what will actually trade', () => {
  const LONG50 = { qty: 50, avgPrice: 180, notionalBasisInr: 747_000, leverage: 1 }

  it('shows a Fills row naming the shortfall', () => {
    const lines = buildConfirmLines(order({ qty: 50, fillableQty: 20, price: 190 }), ctx({ position: LONG50 }))
    expect(valueOf(lines, 'Quantity')).toBe('50')
    expect(valueOf(lines, 'Fills')).toBe('20 of 50 — book depth')
  })

  it('realizes P&L on the fillable quantity, not the requested one', () => {
    const lines = buildConfirmLines(order({ qty: 50, fillableQty: 20, price: 190 }), ctx({ position: LONG50 }))
    // (190 − 180) × 20 × 83 = ₹16,600 — NOT ₹41,500 for the full 50.
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹16,600')
  })

  it('a loss is not overstated either', () => {
    const lines = buildConfirmLines(order({ qty: 50, fillableQty: 20, price: 170 }), ctx({ position: LONG50 }))
    // (170 − 180) × 20 × 83 = −₹16,600
    expect(valueOf(lines, 'Gross P&L')).toBe('−₹16,600')
  })

  it('says so plainly when nothing can fill', () => {
    const lines = buildConfirmLines(order({ qty: 50, fillableQty: 0, price: 190 }), ctx({ position: LONG50 }))
    expect(valueOf(lines, 'Fills')).toBe('0 of 50 — no liquidity')
    expect(valueOf(lines, 'Gross P&L')).toBeUndefined() // nothing trades, nothing realized
  })

  it('the Fills row is destructive-toned, never quiet', () => {
    const lines = buildConfirmLines(order({ qty: 50, fillableQty: 20 }), ctx({ position: LONG50 }))
    expect(lines.find((l) => l.k === 'Fills')?.tone).toBe('destructive')
  })

  it('no Fills row when the book covers the whole order', () => {
    const lines = buildConfirmLines(order({ qty: 50, fillableQty: 50 }), ctx({ position: LONG50 }))
    expect(lines.map((l) => l.k)).not.toContain('Fills')
  })

  it('no Fills row when fillableQty is absent — the default is the full order', () => {
    const lines = buildConfirmLines(order({ qty: 10 }), ctx())
    expect(lines.map((l) => l.k)).not.toContain('Fills')
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹8,300') // unchanged from before
  })

  it('a partial close no longer claims to flatten the position', () => {
    // 20 of 50 leaves 30 open, so the caller marks closes=false and a real
    // liquidation estimate survives into the dialog.
    const lines = buildConfirmLines(
      order({ qty: 50, fillableQty: 20, price: 190, closes: false, liq: 120 }),
      ctx({ position: LONG50 }),
    )
    expect(valueOf(lines, 'Est. Liquidation')).toBe('$120.00')
  })
})
