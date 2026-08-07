import { describe, expect, it } from 'vitest'
import { depthCountLabel, ladderOverflows, type LadderMetrics, spreadScrollTop } from './depthLadder'

/**
 * A realistic ladder: 30 ask levels at 22px each above the spread, a 20px
 * spread divider, 30 bid levels below, inside the ~147px the panel actually
 * gives it. This is the exact case the user hit — the spread sits 660px down
 * a 1,340px stack and the browser opens at 0, so only far-away asks show.
 */
const REAL: LadderMetrics = {
  spreadTop: 660,
  spreadHeight: 20,
  viewportHeight: 147,
  contentHeight: 1340,
}

describe('spreadScrollTop — open the ladder where a trader looks', () => {
  it('centres the spread rather than opening on the furthest asks', () => {
    // 660 + 10 − 73.5 = 596.5 → 597. The old behaviour was 0, which showed the
    // top of the ask stack and no bids at all.
    expect(spreadScrollTop(REAL)).toBe(597)
  })

  it('puts the spread band in the middle of the viewport', () => {
    const top = spreadScrollTop(REAL)
    const spreadCentre = REAL.spreadTop + REAL.spreadHeight / 2
    const viewportCentre = top + REAL.viewportHeight / 2
    expect(Math.abs(spreadCentre - viewportCentre)).toBeLessThanOrEqual(1)
  })

  it('shows bids as well as asks once centred', () => {
    const top = spreadScrollTop(REAL)
    expect(top).toBeLessThan(REAL.spreadTop) // asks still visible above
    expect(top + REAL.viewportHeight).toBeGreaterThan(REAL.spreadTop + REAL.spreadHeight) // bids below
  })

  it('a book that fits needs no scrolling at all', () => {
    expect(spreadScrollTop({ spreadTop: 40, spreadHeight: 20, viewportHeight: 147, contentHeight: 100 })).toBe(0)
  })

  it('content exactly filling the viewport does not scroll', () => {
    expect(spreadScrollTop({ spreadTop: 60, spreadHeight: 20, viewportHeight: 147, contentHeight: 147 })).toBe(0)
  })

  it('never scrolls past the top when the spread is near the start', () => {
    // One ask level, thirty bids: centring would want a negative offset.
    expect(spreadScrollTop({ spreadTop: 22, spreadHeight: 20, viewportHeight: 147, contentHeight: 700 })).toBe(0)
  })

  it('never scrolls past the bottom when the spread is near the end', () => {
    // Thirty asks, one bid: centring would want to run off the end.
    const m = { spreadTop: 660, spreadHeight: 20, viewportHeight: 147, contentHeight: 702 }
    expect(spreadScrollTop(m)).toBe(702 - 147)
  })

  it('is an integer — fractional scrollTop causes sub-pixel jitter', () => {
    expect(Number.isInteger(spreadScrollTop({ ...REAL, viewportHeight: 145 }))).toBe(true)
  })

  it('survives a zero-height measurement taken before layout settles', () => {
    expect(spreadScrollTop({ spreadTop: 0, spreadHeight: 0, viewportHeight: 0, contentHeight: 0 })).toBe(0)
  })

  it('survives NaN measurements from a detached node', () => {
    const m = { spreadTop: Number.NaN, spreadHeight: 0, viewportHeight: Number.NaN, contentHeight: 0 }
    expect(spreadScrollTop(m)).toBe(0)
  })
})

describe('depthCountLabel — how deep each side runs', () => {
  it('reads bids × asks', () => {
    expect(depthCountLabel(12, 9)).toBe('12 × 9')
  })

  it('shows zeroes rather than hiding an empty side', () => {
    expect(depthCountLabel(0, 4)).toBe('0 × 4')
    expect(depthCountLabel(0, 0)).toBe('0 × 0')
  })
})

describe('ladderOverflows — is anything hidden below the fold', () => {
  it('true when the book is taller than the panel', () => {
    expect(ladderOverflows({ viewportHeight: 147, contentHeight: 1340 })).toBe(true)
  })

  it('false when it fits', () => {
    expect(ladderOverflows({ viewportHeight: 147, contentHeight: 100 })).toBe(false)
  })

  it('tolerates a sub-pixel overhang rather than nagging about 0.5px', () => {
    expect(ladderOverflows({ viewportHeight: 147, contentHeight: 147.5 })).toBe(false)
  })
})
