import { describe, expect, it } from 'vitest'
import {
  buildLiquidationLines,
  closingSide,
  hasCrossed,
  liquidationWarning,
  pastLabel,
  type RiskRow,
} from './liquidationPanel'

/** Short 10 @ $100 (liquidation $200), mark at $220 — 10% past. */
const CROSSED: RiskRow = {
  username: 'team01',
  ticker: 'AAPL',
  side: 'short',
  qty: -10,
  entryPrice: 100,
  markPrice: 220,
  liquidationPrice: 200,
  pastByUsd: 20,
  pastByPct: 10,
  notionalBasisInr: 83_000,
}

/** The same short at $150 — losing badly, but not past the threshold. */
const NOT_CROSSED: RiskRow = { ...CROSSED, markPrice: 150, pastByUsd: -50, pastByPct: -25 }

const valueOf = (lines: { k: string; v: string }[], k: string) => lines.find((l) => l.k === k)?.v
const keys = (lines: { k: string }[]) => lines.map((l) => l.k)

// ---------------------------------------------------------------------------

describe('pastLabel', () => {
  it('signs a crossed position positively', () => {
    expect(pastLabel(10)).toBe('+10.0%')
  })

  it('signs an uncrossed one negatively, with a real minus sign', () => {
    expect(pastLabel(-25)).toBe('−25.0%')
  })

  it('rounds to one decimal', () => {
    expect(pastLabel(12.44)).toBe('+12.4%')
    expect(pastLabel(12.46)).toBe('+12.5%')
  })

  it('a value that rounds to zero shows unsigned, never "−0.0%"', () => {
    expect(pastLabel(0)).toBe('0.0%')
    expect(pastLabel(-0.001)).toBe('0.0%')
  })

  it('survives a non-finite value', () => {
    expect(pastLabel(Number.NaN)).toBe('—')
    expect(pastLabel(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

describe('hasCrossed', () => {
  it('true only once the mark is genuinely past the threshold', () => {
    expect(hasCrossed(CROSSED)).toBe(true)
    expect(hasCrossed(NOT_CROSSED)).toBe(false)
  })

  it('exactly at the threshold is not yet past it', () => {
    expect(hasCrossed({ pastByUsd: 0 })).toBe(false)
  })
})

describe('closingSide', () => {
  it('a short is closed by buying back', () => {
    expect(closingSide({ side: 'short' })).toBe('buy')
  })

  it('a long is closed by selling out', () => {
    expect(closingSide({ side: 'long' })).toBe('sell')
  })
})

describe('the confirmation dialog', () => {
  it('leads with WHOSE position it is', () => {
    const lines = buildLiquidationLines(CROSSED)
    expect(lines[0].k).toBe('Account')
    expect(lines[0].v).toBe('team01')
    expect(lines[0].tone).toBe('destructive')
  })

  it('shows the full picture the desk needs to judge', () => {
    expect(keys(buildLiquidationLines(CROSSED))).toEqual([
      'Account', 'Instrument', 'Position', 'Entry', 'Mark',
      'Liquidation', 'Past threshold', 'Cost basis', 'Closes with',
    ])
  })

  it('quotes the prices and the size', () => {
    const lines = buildLiquidationLines(CROSSED)
    expect(valueOf(lines, 'Instrument')).toBe('AAPL')
    expect(valueOf(lines, 'Position')).toBe('SHORT 10') // absolute size, never "-10"
    expect(valueOf(lines, 'Entry')).toBe('$100.00')
    expect(valueOf(lines, 'Mark')).toBe('$220.00')
    expect(valueOf(lines, 'Liquidation')).toBe('$200.00')
    expect(valueOf(lines, 'Cost basis')).toBe('₹83,000')
  })

  it('says which way the closing trade goes', () => {
    expect(valueOf(buildLiquidationLines(CROSSED), 'Closes with')).toBe('BUY at market')
    expect(valueOf(buildLiquidationLines({ ...CROSSED, side: 'long', qty: 10 }), 'Closes with')).toBe('SELL at market')
  })

  it('labels a crossed position as past its threshold, in destructive tone', () => {
    const lines = buildLiquidationLines(CROSSED)
    expect(valueOf(lines, 'Past threshold')).toBe('+10.0%')
    expect(lines.find((l) => l.k === 'Past threshold')?.tone).toBe('destructive')
  })

  it('relabels an uncrossed position rather than claiming it is past', () => {
    const lines = buildLiquidationLines(NOT_CROSSED)
    expect(keys(lines)).not.toContain('Past threshold')
    expect(valueOf(lines, 'Short of threshold')).toBe('−25.0%')
    expect(lines.find((l) => l.k === 'Short of threshold')?.tone).toBeUndefined()
  })
})

describe('the warning text', () => {
  it('states the action is immediate and irreversible', () => {
    const w = liquidationWarning(CROSSED)
    expect(w).toContain('team01')
    expect(w).toContain('immediately and irreversibly')
    expect(w).toContain('real fill, real commission, real P&L')
  })

  it('a crossed position simply confirms the mark has passed', () => {
    expect(liquidationWarning(CROSSED)).toContain('has passed the liquidation price')
    expect(liquidationWarning(CROSSED)).not.toContain('NOT crossed')
  })

  it('an UNCROSSED position is called out as a discretionary call', () => {
    const w = liquidationWarning(NOT_CROSSED)
    expect(w).toContain('NOT crossed its liquidation price')
    expect(w).toContain('discretionary call')
    expect(w).toContain('logged as such')
  })

  it('names the account in both cases — never an anonymous "this position"', () => {
    expect(liquidationWarning(CROSSED)).toContain('team01')
    expect(liquidationWarning(NOT_CROSSED)).toContain('team01')
  })
})
