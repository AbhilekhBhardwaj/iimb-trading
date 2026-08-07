import { describe, expect, it } from 'vitest'
import {
  applyCashFill,
  closingPnlBreakdown,
  DEFAULT_COMMISSION_RATE,
  commissionInrFor,
  FLAT_CASH,
  type CashPosition,
} from '../src/index'

const RATE = 83
/**
 * Commission is charged at whatever RATE is passed — there is no on/off gate at
 * this layer. `FREE` (rate 0) is the only way to charge nothing.
 */
const ON = DEFAULT_COMMISSION_RATE
const FREE = 0

/** Long 10 @ $180, basis ₹149,400 (10 × 180 × 83), unlevered. */
const LONG: CashPosition = { qty: 10, avgPrice: 180, notionalBasisInr: 149_400, leverage: 1 }
/** Short 10 @ $180, basis −₹149,400. */
const SHORT: CashPosition = { qty: -10, avgPrice: 180, notionalBasisInr: -149_400, leverage: 1 }

describe('commissionInrFor', () => {
  it('is rate × notional × fx when the round has commission enabled', () => {
    // 0.003 × 10 × 190 × 83 = ₹473.10
    expect(commissionInrFor(10, 190, RATE, ON)).toBeCloseTo(473.1, 6)
    expect(commissionInrFor(10, 190, RATE, ON)).toBeCloseTo(DEFAULT_COMMISSION_RATE * 10 * 190 * RATE, 9)
  })

  it('is exactly zero only at rate 0 — the toggle does not gate the charge', () => {
    expect(commissionInrFor(10, 190, RATE, 0)).toBe(0)
  })

  it('ignores the sign of the fill — a sell is charged like a buy', () => {
    expect(commissionInrFor(-10, 190, RATE, ON)).toBe(commissionInrFor(10, 190, RATE, ON))
  })

  it('scales linearly with quantity, price and rate', () => {
    expect(commissionInrFor(20, 190, RATE, ON)).toBeCloseTo(2 * commissionInrFor(10, 190, RATE, ON), 9)
    expect(commissionInrFor(10, 380, RATE, ON)).toBeCloseTo(2 * commissionInrFor(10, 190, RATE, ON), 9)
    expect(commissionInrFor(10, 190, 2 * RATE, ON)).toBeCloseTo(2 * commissionInrFor(10, 190, RATE, ON), 9)
  })
})

describe('closingPnlBreakdown — no breakdown when nothing is realized', () => {
  it('returns null for a fresh buy opening a new position', () => {
    expect(closingPnlBreakdown(FLAT_CASH, 10, 180, RATE, 1, ON)).toBeNull()
  })

  it('returns null for a fresh SHORT opening a new position', () => {
    expect(closingPnlBreakdown(FLAT_CASH, -10, 180, RATE, 1, ON)).toBeNull()
  })

  it('returns null when adding to an existing long', () => {
    expect(closingPnlBreakdown(LONG, 5, 190, RATE, 1, ON)).toBeNull()
  })

  it('returns null when adding to an existing short', () => {
    expect(closingPnlBreakdown(SHORT, -5, 170, RATE, 1, ON)).toBeNull()
  })

  it('returns null regardless of the commission rate', () => {
    expect(closingPnlBreakdown(FLAT_CASH, 10, 180, RATE, 1, FREE)).toBeNull()
    expect(closingPnlBreakdown(LONG, 5, 190, RATE, 1, FREE)).toBeNull()
  })
})

describe('closingPnlBreakdown — commission ON', () => {
  it('splits a full close into gross, commission and net', () => {
    const b = closingPnlBreakdown(LONG, -10, 190, RATE, 1, ON)!
    expect(b.closedQty).toBe(10)
    // (190 − 180) × 10 × 83 = ₹8,300
    expect(b.grossPnlInr).toBeCloseTo(8_300, 6)
    expect(b.commissionInr).toBeCloseTo(473.1, 6)
    expect(b.netPnlInr).toBeCloseTo(7_826.9, 6)
  })

  it('net is always gross minus commission', () => {
    const b = closingPnlBreakdown(LONG, -10, 190, RATE, 1, ON)!
    expect(b.netPnlInr).toBeCloseTo(b.grossPnlInr - b.commissionInr, 9)
  })

  it('realizes proportionally on a partial reduce', () => {
    const b = closingPnlBreakdown(LONG, -4, 190, RATE, 1, ON)!
    expect(b.closedQty).toBe(4)
    expect(b.grossPnlInr).toBeCloseTo(3_320, 6) // 830 × 4
    expect(b.commissionInr).toBeCloseTo(189.24, 6) // 0.003 × 4 × 190 × 83
    expect(b.netPnlInr).toBeCloseTo(3_130.76, 6)
  })

  it('handles a closing LOSS — commission deepens it rather than offsetting', () => {
    const b = closingPnlBreakdown(LONG, -10, 170, RATE, 1, ON)!
    expect(b.grossPnlInr).toBeCloseTo(-8_300, 6)
    expect(b.commissionInr).toBeCloseTo(423.3, 6) // 0.003 × 10 × 170 × 83
    expect(b.netPnlInr).toBeCloseTo(-8_723.3, 6)
    expect(b.netPnlInr).toBeLessThan(b.grossPnlInr)
  })

  it('closes a SHORT at a profit when the price falls', () => {
    const b = closingPnlBreakdown(SHORT, 10, 170, RATE, 1, ON)!
    expect(b.closedQty).toBe(10)
    expect(b.grossPnlInr).toBeCloseTo(8_300, 6)
    expect(b.commissionInr).toBeCloseTo(423.3, 6)
    expect(b.netPnlInr).toBeCloseTo(7_876.7, 6)
  })

  it('charges the FULL fill on a flip, while gross covers only the closed units', () => {
    // Sell 15 against a long 10: 10 units close, 5 open a new short.
    const b = closingPnlBreakdown(LONG, -15, 190, RATE, 1, ON)!
    expect(b.closedQty).toBe(10)
    expect(b.grossPnlInr).toBeCloseTo(8_300, 6) // closed units only
    expect(b.commissionInr).toBeCloseTo(709.65, 6) // 0.003 × 15 × 190 × 83 — all 15
    expect(b.netPnlInr).toBeCloseTo(7_590.35, 6)
  })

  it('takes gross straight from applyCashFill, so preview and settlement agree', () => {
    const outcome = applyCashFill(LONG, -10, 190, RATE, 1)
    const b = closingPnlBreakdown(LONG, -10, 190, RATE, 1, ON)!
    expect(b.grossPnlInr).toBe(outcome.realizedPnlInr)
    expect(b.closedQty).toBe(outcome.closedQty)
  })
})

describe('closingPnlBreakdown — rate 0 (a free round)', () => {
  it('reports zero commission and net equal to gross', () => {
    const b = closingPnlBreakdown(LONG, -10, 190, RATE, 1, FREE)!
    expect(b.closedQty).toBe(10)
    expect(b.grossPnlInr).toBeCloseTo(8_300, 6)
    expect(b.commissionInr).toBe(0)
    expect(b.netPnlInr).toBe(b.grossPnlInr)
  })

  it('leaves gross identical to the commission-ON case — only charges differ', () => {
    const on = closingPnlBreakdown(LONG, -10, 190, RATE, 1, ON)!
    const off = closingPnlBreakdown(LONG, -10, 190, RATE, 1, FREE)!
    expect(off.grossPnlInr).toBe(on.grossPnlInr)
    expect(off.closedQty).toBe(on.closedQty)
    expect(off.netPnlInr - on.netPnlInr).toBeCloseTo(on.commissionInr, 9)
  })

  it('does not soften a loss either', () => {
    const b = closingPnlBreakdown(LONG, -10, 170, RATE, 1, FREE)!
    expect(b.grossPnlInr).toBeCloseTo(-8_300, 6)
    expect(b.netPnlInr).toBe(-8_300)
  })
})

describe('closingPnlBreakdown — leverage and rate', () => {
  it('P&L is on full notional, so leverage does not change gross or net', () => {
    const levered: CashPosition = { qty: 10, avgPrice: 180, notionalBasisInr: 149_400, leverage: 5 }
    const flat = closingPnlBreakdown(LONG, -10, 190, RATE, 1, ON)!
    const lev = closingPnlBreakdown(levered, -10, 190, RATE, 5, ON)!
    expect(lev.grossPnlInr).toBeCloseTo(flat.grossPnlInr, 9)
    expect(lev.netPnlInr).toBeCloseTo(flat.netPnlInr, 9)
  })

  it('a pure FX move realizes P&L even at an unchanged USD price', () => {
    const b = closingPnlBreakdown(LONG, -10, 180, 90, 1, ON)!
    // basis ₹14,940/unit vs exit 180 × 90 = ₹16,200/unit → ₹1,260 × 10
    expect(b.grossPnlInr).toBeCloseTo(12_600, 6)
    expect(b.commissionInr).toBeCloseTo(DEFAULT_COMMISSION_RATE * 10 * 180 * 90, 9)
  })
})
