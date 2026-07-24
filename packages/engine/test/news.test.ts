import { describe, it, expect } from 'vitest'
import { createRng } from '../src/rng'
import { tickStock, type Stock } from '../src/price'
import {
  applyNewsEffect,
  impactEnvelope,
  newsAdjustedPrice,
  newsEffectForStock,
  type NewsImpact,
  type NewsItem,
} from '../src/news'
import { NEWS_OVERSHOOT } from '../src/config'

function makeStock(overrides: Partial<Stock> = {}): Stock {
  return { ticker: 'AAA', name: 'Alpha Co', sector: 'Tech', price: 100, vol: 0.5, ...overrides }
}

function makeNews(
  over: Omit<Partial<NewsItem>, 'impact'> & { impact?: Partial<NewsImpact> } = {},
): NewsItem {
  const { impact, ...rest } = over
  return {
    id: 'n1',
    headline: 'Headline',
    body: 'Body',
    fireAtSeconds: 0,
    isHerring: false,
    ...rest,
    impact: { primary: {}, related: {}, sector: {}, market: 0, ...(impact ?? {}) },
  }
}

describe('news impact model', () => {
  it('leaves the price EXACTLY unchanged during the 0-30s reaction window', () => {
    const stock = makeStock({ price: 100 })
    const news = [makeNews({ fireAtSeconds: 100, impact: { primary: { AAA: 0.06 } } })]
    // Every instant in [fireAt, fireAt+30] must be bit-for-bit unchanged.
    for (const t of [100, 101, 115, 129, 129.999, 130]) {
      expect(newsEffectForStock(news, 'AAA', 'Tech', t)).toBe(0)
      expect(newsAdjustedPrice(stock, news, t)).toBe(100)
    }
    // Just past the window, it must start moving.
    expect(newsEffectForStock(news, 'AAA', 'Tech', 131)).toBeGreaterThan(0)
  })

  it('overshoots to ~target*overshoot at the peak, then retraces toward target', () => {
    const target = 0.1
    const news = [makeNews({ fireAtSeconds: 0, impact: { primary: { AAA: target } } })]
    const at = (t: number) => newsEffectForStock(news, 'AAA', 'Tech', t)

    const peak = at(75) // end of rise phase
    const midRetrace = at(97.5) // halfway through retrace
    const settled = at(120) // end of retrace

    // Peak sits at target * overshoot (1.3x) and clearly above the target.
    expect(peak).toBeCloseTo(target * NEWS_OVERSHOOT, 9)
    expect(peak).toBeGreaterThan(target)
    // Then it retraces back down toward the target.
    expect(midRetrace).toBeLessThan(peak)
    expect(midRetrace).toBeGreaterThan(settled)
    expect(settled).toBeCloseTo(target, 9)
  })

  it('composes two news items on the same stock (+5% and +3% -> ~+8%)', () => {
    const news = [
      makeNews({ id: 'a', fireAtSeconds: 0, impact: { primary: { AAA: 0.05 } } }),
      makeNews({ id: 'b', fireAtSeconds: 0, impact: { primary: { AAA: 0.03 } } }),
    ]
    // Both fully settled: deltas add rather than overwrite.
    const effect = newsEffectForStock(news, 'AAA', 'Tech', 200)
    expect(effect).toBeCloseTo(0.08, 9)
    expect(newsAdjustedPrice(makeStock({ price: 100 }), news, 200)).toBeCloseTo(108, 6)
  })

  it('a sector news item moves every stock in that sector (and not others)', () => {
    const news = [makeNews({ fireAtSeconds: 0, impact: { sector: { Tech: 0.05 } } })]
    const tone = makeStock({ ticker: 'AAA', sector: 'Tech' })
    const ttwo = makeStock({ ticker: 'BBB', sector: 'Tech' })
    const energy = makeStock({ ticker: 'CCC', sector: 'Energy' })

    expect(newsEffectForStock(news, tone.ticker, tone.sector, 200)).toBeCloseTo(0.05, 9)
    expect(newsEffectForStock(news, ttwo.ticker, ttwo.sector, 200)).toBeCloseTo(0.05, 9)
    expect(newsEffectForStock(news, energy.ticker, energy.sector, 200)).toBe(0)
  })

  it('a herring produces negligible movement despite large impact numbers', () => {
    const stock = makeStock({ price: 100 })
    const herring = [
      makeNews({
        fireAtSeconds: 0,
        isHerring: true,
        impact: { primary: { AAA: 0.25 }, sector: { Tech: 0.25 }, market: 0.25 },
      }),
    ]
    // No effect at any phase of the timeline.
    for (const t of [0, 50, 75, 120, 300]) {
      expect(newsEffectForStock(herring, 'AAA', 'Tech', t)).toBe(0)
      expect(newsAdjustedPrice(stock, herring, t)).toBe(100)
    }
  })

  it('after 120s the price reflects the fully-settled delta', () => {
    const stock = makeStock({ price: 200 })
    const news = [makeNews({ fireAtSeconds: 0, impact: { primary: { AAA: -0.06 } } })]
    // Settled effect equals the raw target delta (envelope == 1).
    expect(impactEnvelope(200)).toBe(1)
    expect(newsEffectForStock(news, 'AAA', 'Tech', 200)).toBeCloseTo(-0.06, 9)
    expect(newsAdjustedPrice(stock, news, 200)).toBeCloseTo(200 * 0.94, 6)
  })

  it('shifts the level on top of the GBM walk (news composes with the walk)', () => {
    // Walk a baseline forward with GBM noise, then overlay a settled news shift.
    const rng = createRng(99)
    let stock = makeStock({ price: 100, vol: 0.5 })
    for (let i = 0; i < 200; i++) stock = tickStock(stock, rng)
    const baseline = stock.price

    expect(baseline).not.toBe(100) // the walk actually moved the level

    const news = [makeNews({ fireAtSeconds: 0, impact: { primary: { AAA: 0.06 } } })]
    const displayed = newsAdjustedPrice(stock, news, 500)
    // Displayed level = walked baseline shifted by the settled +6%.
    expect(displayed).toBeCloseTo(baseline * 1.06, 9)
    expect(applyNewsEffect(baseline, 0.06)).toBeCloseTo(displayed, 12)
  })
})
