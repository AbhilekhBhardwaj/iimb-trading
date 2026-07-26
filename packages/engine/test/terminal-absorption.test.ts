import { describe, it, expect } from 'vitest'
import { createRng, dtYears } from '../src'
import { INITIAL_STOCKS, NEWS_TIMELINE, stepPrices } from '../../../src/lib/simulation'

/**
 * Cross-layer guard for the terminal's simulation: multiple headlines must
 * compose over their FULL respective windows. A stock still absorbing an earlier
 * headline must keep moving when a later headline fires — the meander-toward-
 * target behavior must not re-introduce a global freeze that overrides it.
 *
 * Scenario uses the real timeline: news #1 (t=15) lifts NVDA/Tech; news #2
 * (t=80) is MARKET-WIDE (market -0.03), so it touches every stock — which is
 * exactly why the earlier bug flat-lined the whole board during t=80..110.
 */
describe('terminal simulation: headlines compose across their windows', () => {
  const NV = INITIAL_STOCKS.findIndex((s) => s.ticker === 'NVDA')
  const SPY = INITIAL_STOCKS.findIndex((s) => s.ticker === 'SPY')
  const spyStart = INITIAL_STOCKS[SPY].price
  const news2FireAt = NEWS_TIMELINE[1].fireAtSeconds // 80

  // Replay the sim tick-by-tick and record NVDA/SPY prices.
  const rng = createRng(2024)
  const dt = dtYears(1)
  let prices = INITIAL_STOCKS.map((s) => s.price)
  const nvda: number[] = []
  const spy: number[] = []
  for (let t = 1; t <= 110; t++) {
    prices = stepPrices(prices, t, rng, dt)
    nvda[t] = prices[NV]
    spy[t] = prices[SPY]
  }

  it('NVDA keeps moving through news #2 reaction window (still absorbing news #1)', () => {
    // During t=81..109, news #2 is in NVDA's reaction window (its delta deferred),
    // but news #1 is still being absorbed — so NVDA must keep meandering, not freeze.
    let changed = 0
    for (let t = news2FireAt + 1; t <= 109; t++) if (nvda[t] !== nvda[t - 1]) changed++
    expect(changed).toBeGreaterThan(10) // was 0 before the fix (globally frozen)

    // And it should still be trending toward news #1's (higher) target, not stuck.
    expect(nvda[109]).toBeGreaterThan(nvda[news2FireAt])
  })

  it('still honors the pure freeze: a stock hit ONLY by the new headline stays flat', () => {
    // SPY is untouched by news #1; news #2 hits it only via market -0.03. Through
    // news #2's own 30s reaction window SPY must be EXACTLY flat (deferred).
    for (let t = news2FireAt; t <= news2FireAt + 29; t++) expect(spy[t]).toBe(spyStart)
  })

  it('after the window passes, the market-wide delta finally prices into SPY', () => {
    // One tick past the window, SPY begins absorbing the -0.03 and moves down.
    let p = spyStart
    let localPrices = INITIAL_STOCKS.map((s) => s.price)
    const r = createRng(2024)
    for (let t = 1; t <= 140; t++) {
      localPrices = stepPrices(localPrices, t, r, dt)
      p = localPrices[SPY]
    }
    expect(p).toBeLessThan(spyStart) // market-wide hawkish news pulled SPY down
  })
})
