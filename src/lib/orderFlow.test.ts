import { type CashPosition, DEFAULT_COMMISSION_RATE } from '@iimb-trading/engine'
import { describe, expect, it } from 'vitest'
import {
  buildCancelLines,
  buildConfirmLines,
  buildTradeOutcome,
  closingOrderFor,
  type MarketContext,
  type OrderTerms,
  previewPrice,
} from './orderFlow'

const RATE = 83
/** Long 10 AAPL @ $180, basis ₹149,400. */
const LONG: CashPosition = { qty: 10, avgPrice: 180, notionalBasisInr: 149_400, leverage: 1 }
/** Short 10 AAPL @ $180, basis −₹149,400. */
const SHORT: CashPosition = { qty: -10, avgPrice: 180, notionalBasisInr: -149_400, leverage: 1 }

const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({
  position: LONG,
  usdInrRate: RATE,
  commission: { enabled: true, rate: DEFAULT_COMMISSION_RATE },
  slippageEnabled: true,
  ...over,
})

const order = (over: Partial<OrderTerms> = {}): OrderTerms => ({
  ticker: 'AAPL',
  side: 'sell',
  type: 'limit',
  qty: 10,
  price: 190,
  leverage: 1,
  requiredInr: -1, // a close frees margin
  liq: null,
  closes: true,
  ...over,
})

const keys = (lines: { k: string }[]) => lines.map((l) => l.k)
const valueOf = (lines: { k: string; v: string }[], k: string) => lines.find((l) => l.k === k)?.v

// ---------------------------------------------------------------------------

describe('closingOrderFor — the direction and size that closes a position', () => {
  it('a LONG closes with a SELL of the full size', () => {
    expect(closingOrderFor(LONG)).toEqual({ side: 'sell', qty: 10 })
  })

  it('a SHORT closes with a BUY of the full size', () => {
    expect(closingOrderFor(SHORT)).toEqual({ side: 'buy', qty: 10 })
  })

  it('quantity is always positive, whichever way the position runs', () => {
    expect(closingOrderFor({ qty: -7 })!.qty).toBe(7)
    expect(closingOrderFor({ qty: 7 })!.qty).toBe(7)
  })

  it('a flat or absent position has nothing to close', () => {
    expect(closingOrderFor({ qty: 0 })).toBeNull()
    expect(closingOrderFor(null)).toBeNull()
    expect(closingOrderFor(undefined)).toBeNull()
    expect(closingOrderFor({ qty: Number.NaN })).toBeNull()
  })
})

describe('the confirm dialog is pre-filled correctly from a position', () => {
  it('a full close of a long is a SELL for the whole size', () => {
    const close = closingOrderFor(LONG)!
    const lines = buildConfirmLines(order({ side: close.side, qty: close.qty }), ctx())

    expect(valueOf(lines, 'Instrument')).toBe('AAPL')
    expect(valueOf(lines, 'Side')).toBe('SELL')
    expect(valueOf(lines, 'Quantity')).toBe('10')
    expect(valueOf(lines, 'Type')).toBe('LIMIT')
    expect(valueOf(lines, 'Price')).toBe('$190.00')
  })

  it('a full close of a short is a BUY for the whole size', () => {
    const close = closingOrderFor(SHORT)!
    const lines = buildConfirmLines(
      order({ side: close.side, qty: close.qty, price: 170 }),
      ctx({ position: SHORT }),
    )
    expect(valueOf(lines, 'Side')).toBe('BUY')
    expect(valueOf(lines, 'Quantity')).toBe('10')
  })

  it('carries the realized-P&L preview, exactly as the Terminal does', () => {
    const lines = buildConfirmLines(order(), ctx())
    expect(keys(lines)).toEqual([
      'Instrument', 'Side', 'Type', 'Quantity', 'Price',
      'Leverage', 'Margin Required', 'Est. Liquidation',
      'Gross P&L', 'Commission', 'Net P&L',
    ])
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹8,300') // (190−180) × 10 × 83
    expect(valueOf(lines, 'Net P&L')).toBe('+₹7,827')
  })

  it('shows a closing order as freeing margin, and flat afterwards', () => {
    const lines = buildConfirmLines(order(), ctx())
    expect(valueOf(lines, 'Margin Required')).toBe('— (frees margin)')
    expect(valueOf(lines, 'Est. Liquidation')).toBe('Flat after close')
  })

  it('supports MARKET as well as LIMIT for a close', () => {
    const lines = buildConfirmLines(order({ type: 'market', price: 188.4 }), ctx())
    expect(valueOf(lines, 'Type')).toBe('MARKET')
    expect(valueOf(lines, 'Price')).toBe('~$188.40 at execution')
  })

  it('a PARTIAL close still shows a liquidation estimate for the remainder', () => {
    const lines = buildConfirmLines(order({ qty: 4, closes: false, liq: 120, requiredInr: -1 }), ctx())
    expect(valueOf(lines, 'Quantity')).toBe('4')
    expect(valueOf(lines, 'Est. Liquidation')).toBe('$120.00')
  })

  it('a partial close realizes proportionally', () => {
    const lines = buildConfirmLines(order({ qty: 4, closes: false }), ctx())
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹3,320') // 830 × 4
    expect(valueOf(lines, 'Net P&L')).toBe('+₹3,131')
  })
})

describe('the post-trade outcome — full close', () => {
  const res = { trades: [{ price: 190, qty: 10 }], bestPriceAtSubmit: 190 }

  it('opens the result dialog with the realized breakdown', () => {
    const out = buildTradeOutcome(order(), ctx(), res)
    expect(out.kind).toBe('dialog')
    if (out.kind !== 'dialog') return
    expect(out.title).toBe('Order Filled')
    expect(out.filledQty).toBe(10)
    expect(keys(out.lines)).toEqual(['Instrument', 'Side', 'Filled', 'Avg Fill', 'Gross P&L', 'Commission', 'Net P&L'])
    expect(valueOf(out.lines, 'Filled')).toBe('10')
    expect(valueOf(out.lines, 'Avg Fill')).toBe('$190.00')
    expect(valueOf(out.lines, 'Gross P&L')).toBe('+₹8,300')
  })

  it('no slippage nudge on a clean limit fill', () => {
    const out = buildTradeOutcome(order(), ctx(), res)
    expect(out.kind === 'dialog' && out.note).toBeNull()
  })
})

describe('the post-trade outcome — partial close', () => {
  it('reports filled-of-ordered and realizes only what traded', () => {
    const out = buildTradeOutcome(order({ qty: 10 }), ctx(), { trades: [{ price: 190, qty: 4 }] })
    expect(out.kind).toBe('dialog')
    if (out.kind !== 'dialog') return
    expect(out.title).toBe('Partial Fill')
    expect(out.filledQty).toBe(4)
    expect(valueOf(out.lines, 'Filled')).toBe('4 of 10')
    expect(valueOf(out.lines, 'Gross P&L')).toBe('+₹3,320') // 4 units only
  })

  it('a deliberate partial close (ordered 4, filled 4) is NOT labelled partial', () => {
    const out = buildTradeOutcome(order({ qty: 4, closes: false }), ctx(), { trades: [{ price: 190, qty: 4 }] })
    expect(out.kind === 'dialog' && out.title).toBe('Order Filled')
    expect(out.kind === 'dialog' && valueOf(out.lines, 'Filled')).toBe('4')
  })
})

describe('the post-trade outcome — market close that walks the book', () => {
  const walked = { trades: [{ price: 190, qty: 5 }, { price: 188, qty: 5 }], bestPriceAtSubmit: 190 }

  it('carries the slippage nudge into the same dialog as the P&L', () => {
    const out = buildTradeOutcome(order({ type: 'market' }), ctx(), walked)
    expect(out.kind).toBe('dialog')
    if (out.kind !== 'dialog') return
    expect(valueOf(out.lines, 'Avg Fill')).toBe('$189.00')
    expect(valueOf(out.lines, 'Gross P&L')).toBe('+₹7,470') // (189−180) × 10 × 83
    expect(out.note).toContain('could have saved you $10.00')
  })

  it('respects the round slippage toggle', () => {
    const out = buildTradeOutcome(order({ type: 'market' }), ctx({ slippageEnabled: false }), walked)
    expect(out.kind === 'dialog' && out.note).toBeNull()
  })
})

describe('the post-trade outcome — nothing to show', () => {
  it('an unfilled order rests, as a toast', () => {
    const out = buildTradeOutcome(order({ qty: 10, price: 250 }), ctx(), { trades: [] })
    expect(out).toEqual({ kind: 'toast', ok: true, title: 'Order resting', detail: '10 @ $250.00 on the book' })
  })

  it('an opening fill with commission off is just a toast', () => {
    const out = buildTradeOutcome(
      order({ side: 'buy', qty: 5, price: 190, closes: false }),
      ctx({ position: null, commission: { enabled: false, rate: DEFAULT_COMMISSION_RATE } }),
      { trades: [{ price: 190, qty: 5 }], bestPriceAtSubmit: 190 },
    )
    expect(out).toMatchObject({ kind: 'toast', title: 'Order filled', detail: '5 @ avg $190.00' })
  })
})

describe('buildCancelLines — the cancel confirmation', () => {
  const resting = { ticker: 'AAPL', side: 'buy' as const, type: 'limit' as const, price: 100, qty: 10, remainingQty: 10 }

  it('names the instrument, side, type and price', () => {
    const lines = buildCancelLines(resting)
    expect(keys(lines)).toEqual(['Instrument', 'Side', 'Type', 'Price', 'Cancelling'])
    expect(valueOf(lines, 'Instrument')).toBe('AAPL')
    expect(valueOf(lines, 'Side')).toBe('BUY')
    expect(valueOf(lines, 'Price')).toBe('$100.00')
  })

  it('an untouched order cancels its whole quantity', () => {
    expect(valueOf(buildCancelLines(resting), 'Cancelling')).toBe('10 of 10')
  })

  it('a PARTIALLY filled order cancels only what remains, and says so', () => {
    const lines = buildCancelLines({ ...resting, remainingQty: 6 })
    expect(valueOf(lines, 'Cancelling')).toBe('6 of 10')
    expect(valueOf(lines, 'Already filled')).toBe('4 — stays filled')
  })

  it('does not mention filled quantity when there is none', () => {
    expect(keys(buildCancelLines(resting))).not.toContain('Already filled')
  })

  it('handles an order with no price', () => {
    expect(valueOf(buildCancelLines({ ...resting, price: null }), 'Price')).toBe('—')
  })
})

describe('one implementation — Portfolio and Terminal cannot diverge', () => {
  /**
   * Both surfaces call these same functions, so identical inputs must produce
   * identical output. If the Portfolio ever grew its own copy, this would still
   * pass — but there is only one implementation to call, which is the point.
   */
  it('the same close produces byte-identical confirm rows regardless of caller', () => {
    const fromTerminal = buildConfirmLines(order(), ctx())
    const close = closingOrderFor(LONG)!
    const fromPortfolio = buildConfirmLines(order({ side: close.side, qty: close.qty }), ctx())
    expect(fromPortfolio).toEqual(fromTerminal)
  })

  it('and byte-identical result dialogs', () => {
    const res = { trades: [{ price: 190, qty: 10 }], bestPriceAtSubmit: 190 }
    expect(buildTradeOutcome(order(), ctx(), res)).toEqual(buildTradeOutcome(order(), ctx(), res))
  })

  it('a Portfolio close and a Terminal sell of the same size agree exactly', () => {
    const close = closingOrderFor(LONG)!
    const portfolio = order({ side: close.side, qty: close.qty, type: 'market' })
    const terminal = order({ side: 'sell', qty: 10, type: 'market' })
    const res = { trades: [{ price: 190, qty: 5 }, { price: 188, qty: 5 }], bestPriceAtSubmit: 190 }
    expect(buildTradeOutcome(portfolio, ctx(), res)).toEqual(buildTradeOutcome(terminal, ctx(), res))
  })
})

describe('a rejected order NEVER enters the success flow', () => {
  /**
   * The bug this pins: a rejected order carries no trades, so before the
   * rejection branch existed `filled === 0` sent it down the "Order resting"
   * path — a GREEN toast telling the trader their order was on the book when
   * the server had refused it outright.
   */
  const rejected = {
    accepted: false,
    reason: 'insufficient_margin',
    rejection: { code: 'insufficient_margin' as const, requiredInr: 166_000, availableInr: 40_000 },
  }

  it('is a reject outcome, not a resting toast', () => {
    const out = buildTradeOutcome(order({ side: 'buy', closes: false }), ctx({ position: null }), rejected)
    expect(out.kind).toBe('reject')
  })

  it('never claims the order is on the book', () => {
    const out = buildTradeOutcome(order({ side: 'buy', closes: false }), ctx({ position: null }), rejected)
    expect(JSON.stringify(out)).not.toContain('resting')
    expect(JSON.stringify(out)).not.toContain('on the book')
  })

  it('carries the numbers a trader needs to fix it', () => {
    const out = buildTradeOutcome(order(), ctx(), rejected)
    expect(out.kind === 'reject' && out.detail).toContain('₹1,66,000')
    expect(out.kind === 'reject' && out.detail).toContain('₹40,000')
  })

  it('shows no P&L breakdown — nothing was realized', () => {
    const out = buildTradeOutcome(order(), ctx(), rejected)
    expect(out).not.toHaveProperty('lines')
  })

  it('rejects BEFORE reading trades, even on a contradictory payload', () => {
    // Defensive: accepted:false with fills attached must still reject rather
    // than book a phantom P&L against a trade that did not happen.
    const out = buildTradeOutcome(order(), ctx(), { ...rejected, trades: [{ price: 190, qty: 10 }] })
    expect(out.kind).toBe('reject')
  })

  it.each([
    'no_active_round', 'unknown_instrument', 'invalid_qty',
    'invalid_leverage', 'missing_limit_price', 'no_reference_price', 'insufficient_margin',
  ] as const)('%s reaches the UI as a reject outcome', (code) => {
    const out = buildTradeOutcome(order(), ctx(), { accepted: false, reason: code, rejection: { code } })
    expect(out.kind).toBe('reject')
    expect(out.kind === 'reject' && out.title.startsWith('Order rejected')).toBe(true)
  })

  it('the Portfolio Exit flow rejects identically to the Terminal', () => {
    const close = closingOrderFor(LONG)!
    const fromPortfolio = buildTradeOutcome(order({ side: close.side, qty: close.qty }), ctx(), rejected)
    const fromTerminal = buildTradeOutcome(order({ side: 'sell', qty: 10 }), ctx(), rejected)
    expect(fromPortfolio).toEqual(fromTerminal)
  })
})

describe('an ACCEPTED order still behaves exactly as before', () => {
  it('a filled close still opens the normal result dialog', () => {
    const out = buildTradeOutcome(order(), ctx(), { accepted: true, trades: [{ price: 190, qty: 10 }], bestPriceAtSubmit: 190 })
    expect(out.kind).toBe('dialog')
    expect(out.kind === 'dialog' && out.title).toBe('Order Filled')
    expect(out.kind === 'dialog' && valueOf(out.lines, 'Gross P&L')).toBe('+₹8,300')
  })

  it('an accepted-but-unfilled order still rests, as a toast', () => {
    const out = buildTradeOutcome(order({ qty: 10, price: 250 }), ctx(), { accepted: true, trades: [] })
    expect(out).toEqual({ kind: 'toast', ok: true, title: 'Order resting', detail: '10 @ $250.00 on the book' })
  })

  it('adding the accepted flag changed nothing about a successful fill', () => {
    const res = { trades: [{ price: 190, qty: 10 }], bestPriceAtSubmit: 190 }
    expect(buildTradeOutcome(order(), ctx(), { ...res, accepted: true })).toEqual(buildTradeOutcome(order(), ctx(), res))
  })

  it('the slippage nudge still rides along on an accepted market fill', () => {
    const out = buildTradeOutcome(order({ type: 'market' }), ctx(), {
      accepted: true, trades: [{ price: 190, qty: 5 }, { price: 188, qty: 5 }], bestPriceAtSubmit: 190,
    })
    expect(out.kind === 'dialog' && out.note).toContain('could have saved you $10.00')
  })
})

describe('previewPrice — the confirm dialog must not preview at the last trade', () => {
  /**
   * The book has moved since the last print: it traded at $180, but the best
   * ask is now $190 and the best bid $186. An LTP-based preview would quote
   * $180 for a market order in either direction — a price nobody is offering.
   */
  const book = {
    bids: [{ price: 186, qty: 50 }, { price: 185, qty: 40 }],
    asks: [{ price: 190, qty: 30 }, { price: 191, qty: 60 }],
  }
  const STALE_LTP = 180

  it('a market BUY previews at the best ASK, not the last trade', () => {
    expect(previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: 10, depth: book, ltp: STALE_LTP })).toBe(190)
  })

  it('a market SELL previews at the best BID, not the last trade', () => {
    expect(previewPrice({ type: 'market', side: 'sell', limitPrice: Number.NaN, qty: 10, depth: book, ltp: STALE_LTP })).toBe(186)
  })

  it('the two sides differ by the spread — an LTP preview collapses that to one number', () => {
    const buy = previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: 10, depth: book, ltp: STALE_LTP })
    const sell = previewPrice({ type: 'market', side: 'sell', limitPrice: Number.NaN, qty: 10, depth: book, ltp: STALE_LTP })
    expect(buy - sell).toBe(4)
  })

  it('a LIMIT order still previews at its own limit price', () => {
    expect(previewPrice({ type: 'limit', side: 'buy', limitPrice: 175, qty: 10, depth: book, ltp: STALE_LTP })).toBe(175)
  })

  it('takes the BEST level, not just the first one listed', () => {
    expect(previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: 10, depth: book, ltp: STALE_LTP })).toBe(book.asks[0].price)
    expect(previewPrice({ type: 'market', side: 'sell', limitPrice: Number.NaN, qty: 10, depth: book, ltp: STALE_LTP })).toBe(book.bids[0].price)
  })

  it('falls back to LTP when that side of the book is empty', () => {
    const oneSided = { bids: [{ price: 186, qty: 5 }], asks: [] }
    expect(previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: 10, depth: oneSided, ltp: STALE_LTP })).toBe(180)
    expect(previewPrice({ type: 'market', side: 'sell', limitPrice: Number.NaN, qty: 10, depth: oneSided, ltp: STALE_LTP })).toBe(186)
  })

  it('falls back to LTP when depth has not been polled yet', () => {
    expect(previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: 10, depth: null, ltp: STALE_LTP })).toBe(180)
  })

  it('ignores a nonsense level rather than previewing at zero', () => {
    const bad = { bids: [{ price: 0, qty: 10 }], asks: [{ price: -1, qty: 10 }] }
    expect(previewPrice({ type: 'market', side: 'buy', limitPrice: Number.NaN, qty: 10, depth: bad, ltp: STALE_LTP })).toBe(180)
  })
})

describe('the preview P&L follows the BOOK, not the last trade', () => {
  const book = {
    bids: [{ price: 186, qty: 50 }],
    asks: [{ price: 190, qty: 30 }],
  }
  const STALE_LTP = 180

  /** Long 10 @ $180 — bought exactly at the last print, so LTP says break-even. */
  const priceFor = (side: 'buy' | 'sell') =>
    previewPrice({ type: 'market', side, limitPrice: Number.NaN, qty: 10, depth: book, ltp: STALE_LTP })

  it('closing a long previews the REAL gain at the best bid, not break-even at LTP', () => {
    const lines = buildConfirmLines(
      order({ side: 'sell', type: 'market', qty: 10, price: priceFor('sell') }),
      ctx(),
    )
    // Best bid 186 vs entry 180 → (186−180) × 10 × 83 = ₹4,980 gross.
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹4,980')
    expect(valueOf(lines, 'Net P&L')).toBe('+₹4,517')
    // What the stale LTP would have shown instead:
    const stale = buildConfirmLines(order({ side: 'sell', type: 'market', qty: 10, price: STALE_LTP }), ctx())
    expect(valueOf(stale, 'Gross P&L')).toBe('₹0') // break-even — wrong
  })

  it('a book that has fallen shows a LOSS the LTP preview would have hidden', () => {
    const fallen = { bids: [{ price: 172, qty: 50 }], asks: [{ price: 174, qty: 50 }] }
    const px = previewPrice({ type: 'market', side: 'sell', limitPrice: Number.NaN, qty: 10, depth: fallen, ltp: STALE_LTP })
    const lines = buildConfirmLines(order({ side: 'sell', type: 'market', qty: 10, price: px }), ctx())
    // (172−180) × 10 × 83 = −₹6,640. The LTP preview said break-even.
    expect(valueOf(lines, 'Gross P&L')).toBe('−₹6,640')
    expect(valueOf(lines, 'Net P&L')).toBe('−₹7,068') // loss PLUS commission
  })

  it('the previewed Price row quotes the book, not the last trade', () => {
    const lines = buildConfirmLines(order({ side: 'sell', type: 'market', qty: 10, price: priceFor('sell') }), ctx())
    expect(valueOf(lines, 'Price')).toBe('~$186.00 at execution')
  })

  it('margin and liquidation are priced off the book too', () => {
    // Opening a fresh long at 5x: margin must reflect the ask actually payable.
    const px = priceFor('buy')
    const lines = buildConfirmLines(
      order({ side: 'buy', type: 'market', qty: 10, price: px, leverage: 5, requiredInr: (10 * px * 83) / 5, closes: false, liq: 152 }),
      ctx({ position: null }),
    )
    expect(valueOf(lines, 'Margin Required')).toBe('₹31,540') // 10 × 190 × 83 ÷ 5
  })

  it('a LIMIT order is unaffected — its preview was never wrong', () => {
    const lines = buildConfirmLines(order({ side: 'sell', type: 'limit', qty: 10, price: 190 }), ctx())
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹8,300')
    expect(valueOf(lines, 'Price')).toBe('$190.00')
  })
})
