import { describe, expect, it } from 'vitest'
import { applyLeveredFill, liquidationPrice, requiredMargin } from '@iimb-trading/engine'
import {
  cancelLeverage,
  confirmLeverage,
  INITIAL_LEVERAGE,
  isDangerLeverage,
  isSelectableLeverage,
  type LeverageLevel,
  LEVERAGE_LEVELS,
  type LeverageSelection,
  leverageWarningLines,
  leverageWarningText,
  MAX_UNGATED_LEVERAGE,
  selectLeverage,
  wipeoutMovePct,
} from './leverage'

const SAFE = [1, 2, 3, 4, 5] as const
const DANGER = [6, 7] as const
const at = (applied: LeverageLevel, pending: LeverageLevel | null = null): LeverageSelection => ({ applied, pending })
const valueOf = (lines: { k: string; v: string }[], k: string) => lines.find((l) => l.k === k)?.v

// ---------------------------------------------------------------------------

describe('the offered levels', () => {
  it('runs 1x through 7x', () => {
    expect(LEVERAGE_LEVELS).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('starts at 1x with nothing pending', () => {
    expect(INITIAL_LEVERAGE).toEqual({ applied: 1, pending: null })
  })

  it('1x–5x are the ungated tier', () => {
    for (const lv of SAFE) expect(isDangerLeverage(lv)).toBe(false)
  })

  it('6x and 7x are the danger tier', () => {
    for (const lv of DANGER) expect(isDangerLeverage(lv)).toBe(true)
  })

  it('the boundary sits exactly at 5x', () => {
    expect(MAX_UNGATED_LEVERAGE).toBe(5)
    expect(isDangerLeverage(5)).toBe(false)
    expect(isDangerLeverage(6)).toBe(true)
  })

  it('rejects levels off the scale', () => {
    for (const lv of [0, -1, 1.5, 8, 20, Number.NaN]) expect(isSelectableLeverage(lv)).toBe(false)
  })
})

describe('1x–5x apply immediately', () => {
  it.each(SAFE)('selecting %ix applies it on the spot, nothing pending', (lv) => {
    expect(selectLeverage(at(1), lv)).toEqual({ applied: lv, pending: null })
  })

  it('switching between safe levels needs no confirmation', () => {
    let s = at(1)
    s = selectLeverage(s, 3)
    expect(s).toEqual({ applied: 3, pending: null })
    s = selectLeverage(s, 5)
    expect(s).toEqual({ applied: 5, pending: null })
    s = selectLeverage(s, 2)
    expect(s).toEqual({ applied: 2, pending: null })
  })

  it('dropping from a danger level back to a safe one is immediate — de-risking is never gated', () => {
    expect(selectLeverage(at(7), 2)).toEqual({ applied: 2, pending: null })
  })

  it('an off-scale value leaves the selection untouched', () => {
    expect(selectLeverage(at(3), 9)).toEqual({ applied: 3, pending: null })
    expect(selectLeverage(at(3), 0)).toEqual({ applied: 3, pending: null })
  })
})

describe('6x and 7x stage a warning instead of applying', () => {
  it.each(DANGER)('selecting %ix does NOT change the applied leverage', (lv) => {
    const s = selectLeverage(at(2), lv)
    expect(s.applied).toBe(2) // still the old level
    expect(s.pending).toBe(lv)
  })

  it('an order placed while the warning is open still uses the OLD leverage', () => {
    // The property that makes the gate meaningful rather than cosmetic.
    const s = selectLeverage(at(3), 7)
    expect(s.applied).toBe(3)
  })

  it('staging one danger level then the other replaces the pending choice', () => {
    let s = selectLeverage(at(1), 6)
    expect(s.pending).toBe(6)
    s = selectLeverage(s, 7)
    expect(s).toEqual({ applied: 1, pending: 7 })
  })
})

describe('confirming the warning applies the staged level', () => {
  it.each(DANGER)('%ix takes effect only after confirm', (lv) => {
    const staged = selectLeverage(at(1), lv)
    expect(staged.applied).toBe(1)
    expect(confirmLeverage(staged)).toEqual({ applied: lv, pending: null })
  })

  it('confirming with nothing pending is a no-op', () => {
    expect(confirmLeverage(at(4))).toEqual({ applied: 4, pending: null })
  })
})

describe('cancelling reverts to the previous selection', () => {
  it.each(DANGER)('backing out of %ix leaves the old level in force', (lv) => {
    const staged = selectLeverage(at(3), lv)
    expect(cancelLeverage(staged)).toEqual({ applied: 3, pending: null })
  })

  it('cancelling from the default leaves 1x', () => {
    expect(cancelLeverage(selectLeverage(INITIAL_LEVERAGE, 6))).toEqual({ applied: 1, pending: null })
  })

  it('reverts to 5x, not to 1x, when 5x was in force', () => {
    // The revert target is the PREVIOUS selection, not the default.
    expect(cancelLeverage(selectLeverage(at(5), 7))).toEqual({ applied: 5, pending: null })
  })

  it('cancelling twice is harmless', () => {
    const once = cancelLeverage(selectLeverage(at(4), 6))
    expect(cancelLeverage(once)).toEqual({ applied: 4, pending: null })
  })

  it('a full stage → cancel → stage → confirm cycle ends where expected', () => {
    let s: LeverageSelection = at(2)
    s = selectLeverage(s, 6)
    s = cancelLeverage(s)
    expect(s.applied).toBe(2) // reverted
    s = selectLeverage(s, 6)
    s = confirmLeverage(s)
    expect(s).toEqual({ applied: 6, pending: null }) // accepted the second time
  })

  it('re-clicking a danger level already in force does not re-warn', () => {
    const s = selectLeverage(at(6), 6)
    expect(s).toEqual({ applied: 6, pending: null })
  })
})

describe('the warning is concrete, not a lecture', () => {
  const ctx = { side: 'buy' as const, price: 200, qty: 10, usdInrRate: 83 }

  it('names the level and the move that wipes the position out', () => {
    const lines = leverageWarningLines(6, ctx)
    expect(valueOf(lines, 'Leverage')).toBe('6x')
    expect(valueOf(lines, 'Wiped out by')).toBe('a 16.7% move against you')
  })

  it('7x is tighter still', () => {
    expect(valueOf(leverageWarningLines(7, ctx), 'Wiped out by')).toBe('a 14.3% move against you')
  })

  it('quotes the liquidation price the engine will actually use', () => {
    const lines = leverageWarningLines(6, ctx)
    const engineLiq = liquidationPrice({ qty: 10, avgPrice: 200, leverage: 6 })!
    expect(valueOf(lines, 'Est. Liquidation')).toBe(`$${engineLiq.toFixed(2)}`)
    expect(engineLiq).toBeCloseTo(200 * (1 - 1 / 6), 6) // $166.67
  })

  it('a SHORT liquidates above entry, and the warning says so', () => {
    const lines = leverageWarningLines(6, { ...ctx, side: 'sell' })
    expect(valueOf(lines, 'Est. Liquidation')).toBe('$233.33') // 200 × (1 + 1/6)
  })

  it('shows margin posted and the position it controls', () => {
    const lines = leverageWarningLines(6, ctx)
    expect(valueOf(lines, 'Position size')).toBe('₹1,66,000') // 10 × 200 × 83
    expect(valueOf(lines, 'Margin posted')).toBe('₹27,667') // ÷ 6
  })

  it('degrades to the leverage-only rows when the order is not yet costable', () => {
    const lines = leverageWarningLines(6, { ...ctx, price: Number.NaN })
    expect(lines.map((l) => l.k)).toEqual(['Leverage', 'Wiped out by'])
  })

  it('works with no context at all', () => {
    expect(leverageWarningLines(7).map((l) => l.k)).toEqual(['Leverage', 'Wiped out by'])
  })

  it('every row is destructive-toned or neutral, never green', () => {
    for (const l of leverageWarningLines(7, ctx)) expect(l.tone).not.toBe('up')
  })

  it('the prose explains the mechanism, not just the danger', () => {
    const t = leverageWarningText(6)
    expect(t).toContain('16.7%')
    expect(t).toContain('liquidation price')
    expect(t).toContain('wipe out the entire position')
  })
})

describe('margin and liquidation move correctly at EVERY level', () => {
  const flat = { qty: 0, avgPrice: 0, leverage: 1 }
  const RATE = 83
  const PRICE = 200
  const QTY = 10

  it.each(LEVERAGE_LEVELS)('%ix posts notional ÷ leverage as margin', (lv) => {
    const requiredInr = requiredMargin(flat, QTY, PRICE, lv) * RATE
    expect(requiredInr).toBeCloseTo((QTY * PRICE * RATE) / lv, 6)
  })

  it('margin falls as leverage rises — strictly, at every step', () => {
    const margins = LEVERAGE_LEVELS.map((lv) => requiredMargin(flat, QTY, PRICE, lv))
    for (let i = 1; i < margins.length; i++) expect(margins[i]).toBeLessThan(margins[i - 1])
  })

  it('6x posts exactly a sixth of the notional', () => {
    expect(requiredMargin(flat, QTY, PRICE, 6) * RATE).toBeCloseTo(166_000 / 6, 6)
  })

  it.each(LEVERAGE_LEVELS)('a long at %ix liquidates at entry × (1 − 1/L)', (lv) => {
    const pos = applyLeveredFill(flat, QTY, PRICE, lv)
    expect(liquidationPrice(pos)).toBeCloseTo(PRICE * (1 - 1 / lv), 6)
  })

  it.each(LEVERAGE_LEVELS)('a short at %ix liquidates at entry × (1 + 1/L)', (lv) => {
    const pos = applyLeveredFill(flat, -QTY, PRICE, lv)
    expect(liquidationPrice(pos)).toBeCloseTo(PRICE * (1 + 1 / lv), 6)
  })

  it('the liquidation price closes in on entry as leverage rises', () => {
    const gaps = LEVERAGE_LEVELS.map((lv) => PRICE - liquidationPrice(applyLeveredFill(flat, QTY, PRICE, lv))!)
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeLessThan(gaps[i - 1])
  })

  it('1x long is fully collateralized — liquidation only at zero', () => {
    expect(liquidationPrice(applyLeveredFill(flat, QTY, PRICE, 1))).toBe(0)
  })

  it('the warning percentage matches the engine liquidation exactly', () => {
    for (const lv of LEVERAGE_LEVELS) {
      const liq = liquidationPrice(applyLeveredFill(flat, QTY, PRICE, lv))!
      const movePct = ((PRICE - liq) / PRICE) * 100
      expect(movePct).toBeCloseTo(wipeoutMovePct(lv), 6)
    }
  })

  it('6x and 7x are genuinely the sharp end — under a 17% buffer', () => {
    expect(wipeoutMovePct(6)).toBeLessThan(17)
    expect(wipeoutMovePct(7)).toBeLessThan(15)
    expect(wipeoutMovePct(5)).toBe(20)
  })
})
