import { describe, it, expect } from 'vitest'
import { createRng } from '../src/rng'
import { advance, driftTowardStep, tickStock, type Stock } from '../src/price'
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

describe('driftTowardStep — news absorption (wiggle + drift toward target)', () => {
  const dt = dtYears(1)

  /** Run a full absorption window of `n` ticks from `start` toward `target`. */
  function absorb(start: number, target: number, vol: number, reversion: number, n: number, seed: number) {
    const rng = createRng(seed)
    const path = [start]
    let price = start
    for (let i = 0; i < n; i++) {
      price = driftTowardStep(price, target, vol, rng.normal(), reversion, dt)
      path.push(price)
    }
    return path
  }

  it('wanders up and down but trends toward the target over a full window', () => {
    const start = 70
    const target = 80
    const move = target - start
    const path = absorb(start, target, 0.35, 0.025, 120, 4242)
    const end = path[path.length - 1]

    // Lands CLOSE to the target — within a small fraction of the total move...
    expect(Math.abs(end - target)).toBeLessThan(0.2 * move)
    // ...and much nearer the target than where it started (it really moved there).
    expect(Math.abs(end - target)).toBeLessThan(Math.abs(end - start))

    // GENUINE up-and-down variation, not a monotonic ramp/snap.
    let ups = 0
    let downs = 0
    for (let i = 1; i < path.length; i++) {
      if (path[i] > path[i - 1]) ups++
      else if (path[i] < path[i - 1]) downs++
    }
    expect(ups).toBeGreaterThan(5)
    expect(downs).toBeGreaterThan(5) // it dips even while trending up
    const monotonic = path.every((p, i) => i === 0 || p >= path[i - 1])
    expect(monotonic).toBe(false)
  })

  it('is NOT an instant snap: after the first tick it is nowhere near the target', () => {
    const path = absorb(70, 80, 0.35, 0.025, 120, 4242)
    // One tick moves only ~reversion of the way, so it is still close to start.
    expect(Math.abs(path[1] - 70)).toBeLessThan(0.15 * (80 - 70))
  })

  it('works downward too (target below start) and stays deterministic per seed', () => {
    const down = absorb(250, 225, 0.4, 0.03, 120, 99)
    expect(down[down.length - 1]).toBeLessThan(235) // clearly pulled down toward 225
    // Same seed => identical path (engine determinism carries through).
    const a = absorb(100, 110, 0.3, 0.03, 50, 7)
    const b = absorb(100, 110, 0.3, 0.03, 50, 7)
    expect(a).toEqual(b)
  })
})
