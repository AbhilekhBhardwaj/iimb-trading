import { describe, it, expect } from 'vitest'
import { createRng } from '../src/rng'
import { advance, tickStock, type Stock } from '../src/price'
import { DEFAULT_DT_YEARS, dtYears, TIME_COMPRESSION_FACTOR } from '../src/config'

function makeStock(overrides: Partial<Stock> = {}): Stock {
  return { ticker: 'TST', name: 'Test Co', sector: 'Tech', price: 100, vol: 0.5, ...overrides }
}

/** Run a single stock forward `ticks` times, returning the full price path. */
function runPath(stock: Stock, seed: number, ticks: number, dt = DEFAULT_DT_YEARS): number[] {
  const rng = createRng(seed)
  let s = stock
  const path: number[] = [s.price]
  for (let i = 0; i < ticks; i++) {
    s = tickStock(s, rng, dt)
    path.push(s.price)
  }
  return path
}

/** Std dev of final prices across many independent seeded paths at a given vol. */
function finalPriceSpread(vol: number, seedBase: number, paths = 2000, ticks = 500): number {
  const finals: number[] = []
  for (let i = 0; i < paths; i++) {
    const path = runPath(makeStock({ price: 100, vol }), seedBase + i, ticks)
    finals.push(path[path.length - 1])
  }
  const mean = finals.reduce((a, b) => a + b, 0) / finals.length
  const variance = finals.reduce((a, b) => a + (b - mean) ** 2, 0) / finals.length
  return Math.sqrt(variance)
}

describe('GBM price model', () => {
  it('same seed produces an identical price sequence (determinism)', () => {
    const stock = makeStock()
    const a = runPath(stock, 7, 500)
    const b = runPath(stock, 7, 500)
    expect(a).toEqual(b)
  })

  it('different seeds produce different price sequences', () => {
    const stock = makeStock()
    const a = runPath(stock, 7, 500)
    const b = runPath(stock, 8, 500)
    expect(a).not.toEqual(b)
  })

  it('prices stay strictly positive over many ticks (GBM never goes negative)', () => {
    // High vol over a long horizon is the worst case for accidental non-positivity.
    const path = runPath(makeStock({ vol: 1.5 }), 123, 20000)
    for (const p of path) {
      expect(p).toBeGreaterThan(0)
      expect(Number.isFinite(p)).toBe(true)
    }
  })

  it('with mu=0 and low vol, prices drift roughly sideways (no systematic bias)', () => {
    const S0 = 100
    const paths = 2000
    const ticks = 500
    let sumFinal = 0
    let sumLogReturn = 0
    for (let i = 0; i < paths; i++) {
      const path = runPath(makeStock({ price: S0, vol: 0.1 }), 1000 + i, ticks)
      const final = path[path.length - 1]
      sumFinal += final
      sumLogReturn += Math.log(final / S0)
    }
    const meanFinal = sumFinal / paths
    const meanLogReturn = sumLogReturn / paths
    // With mu = 0, E[S_T] = S0, so the average final price sits near the start.
    expect(Math.abs(meanFinal / S0 - 1)).toBeLessThan(0.02)
    // The log-space median drifts by -sigma^2/2 * T, but at low vol that is tiny.
    expect(Math.abs(meanLogReturn)).toBeLessThan(0.01)
  })

  it('higher-vol stocks show larger price swings than lower-vol stocks', () => {
    const lowVolSpread = finalPriceSpread(0.2, 5000)
    const highVolSpread = finalPriceSpread(0.8, 5000)
    // Spread scales ~ linearly with vol, so 4x vol should be clearly wider.
    expect(highVolSpread).toBeGreaterThan(lowVolSpread * 2)
  })

  it('advance() moves every stock and stays deterministic', () => {
    const stocks: Stock[] = [
      makeStock({ ticker: 'AAA', vol: 0.3 }),
      makeStock({ ticker: 'BBB', vol: 0.6 }),
    ]
    const run = (): Stock[] => {
      const rng = createRng(2024)
      let s = stocks
      for (let i = 0; i < 50; i++) s = advance(s, rng)
      return s
    }
    const a = run()
    const b = run()
    expect(a).toEqual(b)
    // Both stocks actually moved from their starting price...
    expect(a[0].price).not.toBe(100)
    expect(a[1].price).not.toBe(100)
    // ...and non-price fields are preserved.
    expect(a[0].ticker).toBe('AAA')
    expect(a[1].ticker).toBe('BBB')
  })

  it('time-compression config maps a 2-hour event onto ~6 months of market time', () => {
    // Ticking once per real second for the whole event should sum to ~0.5 years.
    const realEventSeconds = 2 * 60 * 60
    const totalSimYears = realEventSeconds * dtYears(1)
    expect(totalSimYears).toBeCloseTo(0.5, 6)
    expect(TIME_COMPRESSION_FACTOR).toBeCloseTo(2190, 6)
  })
})
