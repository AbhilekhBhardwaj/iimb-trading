import { describe, expect, it } from 'vitest'
import {
  averageFillPrice,
  bestPriceFrom,
  computeSlippage,
  MIN_NUDGE_USD,
  slippageMessage,
  slippageNudge,
} from './slippage'

/** A book with two levels a side, best-first as the API delivers it. */
const BOOK = {
  asks: [
    { price: 230, qty: 5 },
    { price: 232, qty: 20 },
  ],
  bids: [
    { price: 229, qty: 5 },
    { price: 228, qty: 20 },
  ],
}

describe('bestPriceFrom', () => {
  it('a buy lifts the best (lowest) ask', () => {
    expect(bestPriceFrom(BOOK, 'buy')).toBe(230)
  })

  it('a sell hits the best (highest) bid', () => {
    expect(bestPriceFrom(BOOK, 'sell')).toBe(229)
  })

  it('is null when that side of the book is empty', () => {
    expect(bestPriceFrom({ asks: [], bids: BOOK.bids }, 'buy')).toBeNull()
    expect(bestPriceFrom({ asks: BOOK.asks, bids: [] }, 'sell')).toBeNull()
  })

  it('is null for an absent book', () => {
    expect(bestPriceFrom(null, 'buy')).toBeNull()
    expect(bestPriceFrom(undefined, 'sell')).toBeNull()
  })

  it('rejects a nonsensical level price', () => {
    expect(bestPriceFrom({ asks: [{ price: 0, qty: 5 }], bids: [] }, 'buy')).toBeNull()
    expect(bestPriceFrom({ asks: [{ price: NaN, qty: 5 }], bids: [] }, 'buy')).toBeNull()
  })
})

describe('averageFillPrice', () => {
  it('volume-weights across levels', () => {
    // (5 × 230 + 5 × 232) / 10 = 231
    expect(averageFillPrice([{ price: 230, qty: 5 }, { price: 232, qty: 5 }])).toEqual({
      avgFillPrice: 231,
      filledQty: 10,
    })
  })

  it('weights by size, not by level count', () => {
    // (1 × 230 + 9 × 240) / 10 = 239
    expect(averageFillPrice([{ price: 230, qty: 1 }, { price: 240, qty: 9 }])!.avgFillPrice).toBeCloseTo(239, 9)
  })

  it('is null with no fills', () => {
    expect(averageFillPrice([])).toBeNull()
    expect(averageFillPrice(null)).toBeNull()
    expect(averageFillPrice(undefined)).toBeNull()
  })

  it('ignores malformed fills, and is null if that leaves nothing', () => {
    expect(averageFillPrice([{ price: NaN, qty: 5 }])).toBeNull()
    expect(averageFillPrice([{ price: 230, qty: 0 }])).toBeNull()
    expect(averageFillPrice([{ price: 230, qty: 10 }, { price: NaN, qty: 5 }])!.filledQty).toBe(10)
  })
})

describe('zero slippage → no nudge', () => {
  it('a buy filled entirely at the best ask', () => {
    expect(
      computeSlippage({ orderType: 'market', side: 'buy', bestPrice: 230, fills: [{ price: 230, qty: 10 }] }),
    ).toBeNull()
  })

  it('a sell filled entirely at the best bid', () => {
    expect(
      computeSlippage({ orderType: 'market', side: 'sell', bestPrice: 229, fills: [{ price: 229, qty: 10 }] }),
    ).toBeNull()
  })

  it('several fills that all landed at the best price', () => {
    expect(
      computeSlippage({
        orderType: 'market',
        side: 'buy',
        bestPrice: 230,
        fills: [{ price: 230, qty: 3 }, { price: 230, qty: 7 }],
      }),
    ).toBeNull()
  })

  it('slippageNudge returns null, not an empty string', () => {
    expect(
      slippageNudge({ orderType: 'market', side: 'buy', bestPrice: 230, fills: [{ price: 230, qty: 10 }] }),
    ).toBeNull()
  })
})

describe('walked to a worse level → correct dollar amount', () => {
  const buy = computeSlippage({
    orderType: 'market',
    side: 'buy',
    bestPrice: 230,
    fills: [{ price: 230, qty: 5 }, { price: 232, qty: 5 }],
  })!

  it('computes the average fill across levels', () => {
    expect(buy.avgFillPrice).toBeCloseTo(231, 9)
    expect(buy.filledQty).toBe(10)
  })

  it('computes per-unit and total slippage', () => {
    expect(buy.slippagePerUnit).toBeCloseTo(1, 9) // 231 − 230
    expect(buy.slippageUsd).toBeCloseTo(10, 9) // × 10 units
  })

  it('phrases the nudge exactly as specified', () => {
    expect(slippageMessage(buy)).toBe(
      'Your average fill was $231.00. A limit order at $230.00 could have saved you $10.00 — ' +
        'though it may not have filled your full quantity.',
    )
  })

  it('scales the total with filled quantity, not just the price gap', () => {
    const bigger = computeSlippage({
      orderType: 'market',
      side: 'buy',
      bestPrice: 230,
      fills: [{ price: 230, qty: 50 }, { price: 232, qty: 50 }],
    })!
    expect(bigger.slippagePerUnit).toBeCloseTo(1, 9) // same per unit
    expect(bigger.slippageUsd).toBeCloseTo(100, 9) // ten times the total
  })

  it('handles a walk across three levels', () => {
    // (2 × 230 + 3 × 232 + 5 × 235) / 10 = (460 + 696 + 1175) / 10 = 233.1
    const deep = computeSlippage({
      orderType: 'market',
      side: 'buy',
      bestPrice: 230,
      fills: [{ price: 230, qty: 2 }, { price: 232, qty: 3 }, { price: 235, qty: 5 }],
    })!
    expect(deep.avgFillPrice).toBeCloseTo(233.1, 9)
    expect(deep.slippageUsd).toBeCloseTo(31, 9) // 3.1 × 10
  })
})

describe('sign correctness on both sides', () => {
  it('a BUY that walked UP reports positive slippage', () => {
    const s = computeSlippage({
      orderType: 'market',
      side: 'buy',
      bestPrice: 230,
      fills: [{ price: 232, qty: 10 }],
    })!
    expect(s.slippagePerUnit).toBeGreaterThan(0)
    expect(s.slippageUsd).toBeCloseTo(20, 9)
  })

  it('a SELL that walked DOWN reports positive slippage', () => {
    const s = computeSlippage({
      orderType: 'market',
      side: 'sell',
      bestPrice: 229,
      fills: [{ price: 227, qty: 10 }],
    })!
    expect(s.slippagePerUnit).toBeGreaterThan(0)
    expect(s.slippageUsd).toBeCloseTo(20, 9)
  })

  it('the same numbers mean opposite things per side', () => {
    // Filling at 232 against a best of 230: bad for a buyer, good for a seller.
    const asBuy = computeSlippage({ orderType: 'market', side: 'buy', bestPrice: 230, fills: [{ price: 232, qty: 10 }] })
    const asSell = computeSlippage({ orderType: 'market', side: 'sell', bestPrice: 230, fills: [{ price: 232, qty: 10 }] })
    expect(asBuy).not.toBeNull()
    expect(asSell).toBeNull() // sold ABOVE the best bid — price improvement
  })

  it('price improvement never produces a nudge, either side', () => {
    // Buyer filled below the best ask.
    expect(
      computeSlippage({ orderType: 'market', side: 'buy', bestPrice: 230, fills: [{ price: 228, qty: 10 }] }),
    ).toBeNull()
    // Seller filled above the best bid.
    expect(
      computeSlippage({ orderType: 'market', side: 'sell', bestPrice: 229, fills: [{ price: 231, qty: 10 }] }),
    ).toBeNull()
  })

  it('never reports a negative amount', () => {
    for (const side of ['buy', 'sell'] as const) {
      for (const price of [220, 225, 229, 230, 231, 240]) {
        const s = computeSlippage({ orderType: 'market', side, bestPrice: 230, fills: [{ price, qty: 10 }] })
        if (s) {
          expect(s.slippagePerUnit).toBeGreaterThan(0)
          expect(s.slippageUsd).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('a LIMIT order never nudges', () => {
  it('stays silent even when the fill walked badly', () => {
    expect(
      computeSlippage({
        orderType: 'limit',
        side: 'buy',
        bestPrice: 230,
        fills: [{ price: 232, qty: 5 }, { price: 240, qty: 5 }],
      }),
    ).toBeNull()
  })

  it('stays silent on the sell side too', () => {
    expect(
      computeSlippage({ orderType: 'limit', side: 'sell', bestPrice: 229, fills: [{ price: 200, qty: 10 }] }),
    ).toBeNull()
  })

  it('stays silent no matter how far the price moved', () => {
    for (const price of [1, 100, 229, 230, 231, 500, 10_000]) {
      expect(
        computeSlippage({ orderType: 'limit', side: 'buy', bestPrice: 230, fills: [{ price, qty: 10 }] }),
      ).toBeNull()
      expect(
        slippageNudge({ orderType: 'limit', side: 'buy', bestPrice: 230, fills: [{ price, qty: 10 }] }),
      ).toBeNull()
    }
  })

  it('an identical market order WOULD nudge — proving the type is what suppresses it', () => {
    const args = { side: 'buy' as const, bestPrice: 230, fills: [{ price: 232, qty: 10 }] }
    expect(computeSlippage({ ...args, orderType: 'limit' })).toBeNull()
    expect(computeSlippage({ ...args, orderType: 'market' })).not.toBeNull()
  })
})

describe('nothing to measure', () => {
  it('an order that did not fill produces no nudge', () => {
    expect(computeSlippage({ orderType: 'market', side: 'buy', bestPrice: 230, fills: [] })).toBeNull()
    expect(computeSlippage({ orderType: 'market', side: 'buy', bestPrice: 230, fills: undefined })).toBeNull()
  })

  it('an empty book at submit time produces no nudge', () => {
    expect(
      computeSlippage({ orderType: 'market', side: 'buy', bestPrice: null, fills: [{ price: 232, qty: 10 }] }),
    ).toBeNull()
    expect(
      computeSlippage({ orderType: 'market', side: 'buy', bestPrice: undefined, fills: [{ price: 232, qty: 10 }] }),
    ).toBeNull()
  })

  it('suppresses sub-cent dust that would render as $0.00', () => {
    const dust = computeSlippage({
      orderType: 'market',
      side: 'buy',
      bestPrice: 230,
      fills: [{ price: 230.0001, qty: 10 }], // $0.001 total
    })
    expect(dust).toBeNull()
  })

  it('reports a real charge just above the threshold', () => {
    const s = computeSlippage({
      orderType: 'market',
      side: 'buy',
      bestPrice: 230,
      fills: [{ price: 230.01, qty: 10 }], // $0.10 total
    })!
    expect(s.slippageUsd).toBeGreaterThanOrEqual(MIN_NUDGE_USD)
    expect(slippageMessage(s)).toContain('could have saved you $0.10')
  })
})

describe('slippageNudge end to end', () => {
  it('returns the sentence for a walked market order', () => {
    expect(
      slippageNudge({
        orderType: 'market',
        side: 'sell',
        bestPrice: 229,
        fills: [{ price: 229, qty: 5 }, { price: 227, qty: 5 }],
      }),
    ).toBe(
      'Your average fill was $228.00. A limit order at $229.00 could have saved you $10.00 — ' +
        'though it may not have filled your full quantity.',
    )
  })

  it('composes with bestPriceFrom against a real book shape', () => {
    // Buy 10 into asks of 5 @ 230 then 20 @ 232 → 5 @ 230 + 5 @ 232, avg 231.
    const best = bestPriceFrom(BOOK, 'buy')
    const msg = slippageNudge({
      orderType: 'market',
      side: 'buy',
      bestPrice: best,
      fills: [{ price: 230, qty: 5 }, { price: 232, qty: 5 }],
    })
    expect(msg).toContain('$231.00')
    expect(msg).toContain('$230.00')
    expect(msg).toContain('$10.00')
  })
})
