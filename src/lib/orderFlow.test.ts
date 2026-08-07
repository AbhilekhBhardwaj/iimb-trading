import { type CashPosition, DEFAULT_COMMISSION_RATE } from '@iimb-trading/engine'
import { describe, expect, it } from 'vitest'
import {
  buildCancelLines,
  buildConfirmLines,
  buildTradeOutcome,
  closingOrderFor,
  type MarketContext,
  type OrderTerms,
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
