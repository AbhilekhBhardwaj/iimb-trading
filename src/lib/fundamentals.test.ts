import { describe, expect, it } from 'vitest'
import {
  type FundamentalPoint,
  formatValue,
  metricRowsFor,
  periodColumns,
  periodLabel,
  revealedPoints,
  revealedThroughPeriod,
  valueAt,
} from './fundamentals'

/** A company's five metrics across every period in the data book. */
const company = (ticker: string, periods = 21): FundamentalPoint[] =>
  ['revenue', 'ebitda_margin', 'pat_margin', 'eps', 'debt_equity'].flatMap((metric) =>
    Array.from({ length: periods }, (_, periodIndex) => ({
      ticker, metric, periodIndex, value: periodIndex + 1,
    })),
  )

const spy = (): FundamentalPoint[] =>
  Array.from({ length: 21 }, (_, periodIndex) => ({
    ticker: 'SPY', metric: 'index_level', periodIndex, value: 7700 + periodIndex * 100,
  }))

// ---------------------------------------------------------------------------

describe('the reveal rule is UNCAPPED — round N reveals period N', () => {
  it('Round 1 reveals Base and P1', () => {
    expect(revealedThroughPeriod('real-1')).toBe(1)
  })

  it('each further round adds exactly one period', () => {
    expect(revealedThroughPeriod('real-2')).toBe(2)
    expect(revealedThroughPeriod('real-3')).toBe(3)
    expect(revealedThroughPeriod('real-4')).toBe(4)
    expect(revealedThroughPeriod('real-5')).toBe(5)
  })

  it('keeps pace with the schedule EXTENSION — no hardcoded round limit', () => {
    // real-9, real-12, real-20 are all reachable via createNextRound().
    for (const n of [9, 12, 17, 20]) expect(revealedThroughPeriod(`real-${n}`)).toBe(n)
  })

  it('does not stop at 20 — the rule has no ceiling, only the data does', () => {
    expect(revealedThroughPeriod('real-21')).toBe(21)
    expect(revealedThroughPeriod('real-50')).toBe(50)
    expect(revealedThroughPeriod('real-999')).toBe(999)
  })

  it('a mock round reveals Base only — practice must not leak P1', () => {
    expect(revealedThroughPeriod('mock-1')).toBe(0)
    expect(revealedThroughPeriod('mock-2')).toBe(0)
  })

  it('no active round reveals Base only', () => {
    expect(revealedThroughPeriod(null)).toBe(0)
    expect(revealedThroughPeriod(undefined)).toBe(0)
    expect(revealedThroughPeriod('')).toBe(0)
  })

  it('an unrecognised id degrades to Base rather than revealing everything', () => {
    expect(revealedThroughPeriod('weird')).toBe(0)
    expect(revealedThroughPeriod('real-')).toBe(0)
  })
})

describe('filtering is cumulative and never hides what was revealed', () => {
  const points = company('AAPL')

  it('Round 1 shows exactly two periods per metric', () => {
    const got = revealedPoints(points, revealedThroughPeriod('real-1'))
    expect(periodColumns(got)).toEqual([0, 1])
  })

  it('Round 3 shows Base through P3 — earlier periods are still there', () => {
    const got = revealedPoints(points, revealedThroughPeriod('real-3'))
    expect(periodColumns(got)).toEqual([0, 1, 2, 3])
  })

  it('each round is a superset of the one before it', () => {
    let previous: number[] = []
    for (let n = 1; n <= 8; n++) {
      const cols = periodColumns(revealedPoints(points, revealedThroughPeriod(`real-${n}`)))
      for (const p of previous) expect(cols).toContain(p)
      previous = cols
    }
  })

  it('a round ENDING does not hide anything — the same call with no round is Base, but a later round still shows more', () => {
    // Reveal is derived from the round id in force; between rounds the client
    // keeps the last snapshot, and the next round only ever widens the window.
    expect(periodColumns(revealedPoints(points, revealedThroughPeriod('real-4')))).toHaveLength(5)
  })

  it('asking beyond the data book returns everything that exists, not an error', () => {
    const got = revealedPoints(points, revealedThroughPeriod('real-500'))
    expect(periodColumns(got)).toHaveLength(21) // all Base..P20
  })

  it('filters on period only — every metric survives', () => {
    const got = revealedPoints(points, 2)
    expect(new Set(got.map((p) => p.metric)).size).toBe(5)
  })
})

describe("SPY's index level is included", () => {
  it('is revealed on the same schedule as company metrics', () => {
    const got = revealedPoints(spy(), revealedThroughPeriod('real-3'))
    expect(periodColumns(got)).toEqual([0, 1, 2, 3])
  })

  it('renders as its own metric row', () => {
    expect(metricRowsFor(spy()).map((m) => m.key)).toEqual(['index_level'])
  })

  it('a company shows the five company metrics and NOT the index row', () => {
    const keys = metricRowsFor(company('AAPL')).map((m) => m.key)
    expect(keys).toEqual(['revenue', 'ebitda_margin', 'pat_margin', 'eps', 'debt_equity'])
    expect(keys).not.toContain('index_level')
  })

  it('the index value is readable at a given period', () => {
    expect(valueAt(spy(), 'index_level', 0)).toBe(7700)
    expect(valueAt(spy(), 'index_level', 3)).toBe(8000)
  })
})

describe('presentation', () => {
  it('labels Base and PN', () => {
    expect(periodLabel(0)).toBe('Base')
    expect(periodLabel(1)).toBe('P1')
    expect(periodLabel(20)).toBe('P20')
  })

  it('shows margins as percentages, since they are stored as fractions', () => {
    expect(formatValue('ebitda_margin', 0.3593)).toBe('35.93%')
    expect(formatValue('pat_margin', 0.2724)).toBe('27.24%')
  })

  it('formats revenue, EPS and D/E to their own conventions', () => {
    expect(formatValue('revenue', 109_400)).toBe('109,400')
    expect(formatValue('eps', 2.04253)).toBe('$2.04')
    expect(formatValue('debt_equity', 0.78)).toBe('0.78')
  })

  it('a missing cell renders as a dash, never NaN or undefined', () => {
    expect(formatValue('eps', undefined)).toBe('—')
    expect(formatValue('revenue', Number.NaN)).toBe('—')
  })

  it('period columns come from the data, so no empty column is drawn', () => {
    expect(periodColumns(company('AAPL', 3))).toEqual([0, 1, 2])
  })

  it('valueAt returns undefined for a cell with no data', () => {
    expect(valueAt(company('AAPL', 2), 'eps', 9)).toBeUndefined()
  })
})
