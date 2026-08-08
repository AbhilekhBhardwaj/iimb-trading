import { describe, expect, it } from 'vitest'
import { buildCandles, type PricePoint, visibleRange } from './chartSync'

/** 2026-08-08T12:xx:xxZ as epoch ms, so buckets are readable. */
const T = (hhmmss: string) => Date.parse(`2026-08-08T${hhmmss}Z`)
/** Bucket time (epoch seconds) back to HH:MM:SS, for legible assertions. */
const at = (sec: number) => new Date(sec * 1000).toISOString().slice(11, 19)

const p = (hhmmss: string, price: number, qty = 1): PricePoint => ({ t: T(hhmmss), price, qty })

/** Six trades straddling the 12:05 boundary. */
const TRADES: PricePoint[] = [
  p('12:00:05', 100, 2),
  p('12:00:47', 104, 1),
  p('12:02:13', 98, 3),
  p('12:04:59', 101, 1),
  p('12:05:01', 110, 5),
  p('12:07:30', 107, 2),
]

// ---------------------------------------------------------------------------

describe('trades inside one interval collapse into ONE candle', () => {
  it('five minutes of trades become two candles, not six points', () => {
    const { candles } = buildCandles(TRADES, 300)
    expect(candles).toHaveLength(2)
    expect(candles.map((c) => at(c.time))).toEqual(['12:00:00', '12:05:00'])
  })

  it('the four trades from 12:00:05 to 12:04:59 are ONE 12:00 candle', () => {
    const { candles } = buildCandles(TRADES, 300)
    expect(at(candles[0].time)).toBe('12:00:00')
  })

  it('timestamps are FLOORED to the interval, never rounded or offset', () => {
    // A single trade at 12:04:59 belongs to 12:00, not 12:05.
    const { candles } = buildCandles([p('12:04:59', 100)], 300)
    expect(at(candles[0].time)).toBe('12:00:00')
  })

  it('a trade exactly on the boundary opens the NEXT candle', () => {
    const { candles } = buildCandles([p('12:05:00', 100)], 300)
    expect(at(candles[0].time)).toBe('12:05:00')
  })

  it('every bucket is an exact multiple of the interval', () => {
    for (const sec of [60, 120, 300, 600]) {
      for (const c of buildCandles(TRADES, sec).candles) {
        expect(c.time % sec).toBe(0)
      }
    }
  })
})

describe('OHLC is correct for the trades in each bucket', () => {
  it('open is the first trade, close the last, high/low the extremes', () => {
    const { candles } = buildCandles(TRADES, 300)
    // 12:00 bucket: 100, 104, 98, 101 in that order.
    expect(candles[0]).toMatchObject({ open: 100, high: 104, low: 98, close: 101 })
    // 12:05 bucket: 110 then 107.
    expect(candles[1]).toMatchObject({ open: 110, high: 110, low: 107, close: 107 })
  })

  it('a single trade makes a flat candle', () => {
    const { candles } = buildCandles([p('12:00:10', 42)], 300)
    expect(candles[0]).toMatchObject({ open: 42, high: 42, low: 42, close: 42 })
  })

  it('high and low track extremes regardless of order within the bucket', () => {
    const { candles } = buildCandles(
      [p('12:00:01', 100), p('12:00:02', 150), p('12:00:03', 50), p('12:00:04', 120)],
      300,
    )
    expect(candles[0]).toMatchObject({ open: 100, high: 150, low: 50, close: 120 })
  })

  it('volume sums across the bucket', () => {
    const { volumes } = buildCandles(TRADES, 300)
    expect(volumes[0].value).toBe(2 + 1 + 3 + 1) // 12:00 bucket
    expect(volumes[1].value).toBe(5 + 2) // 12:05 bucket
  })

  it('volumes align 1:1 with candles, same times', () => {
    const { candles, volumes } = buildCandles(TRADES, 300)
    expect(volumes.map((v) => v.time)).toEqual(candles.map((c) => c.time))
  })
})

describe('switching timeframe re-buckets the SAME trades', () => {
  it('1min gives five candles', () => {
    const { candles } = buildCandles(TRADES, 60)
    expect(candles.map((c) => at(c.time))).toEqual([
      '12:00:00', '12:02:00', '12:04:00', '12:05:00', '12:07:00',
    ])
  })

  it('5min gives two', () => {
    expect(buildCandles(TRADES, 300).candles).toHaveLength(2)
  })

  it('10min collapses everything into one', () => {
    const { candles } = buildCandles(TRADES, 600)
    expect(candles).toHaveLength(1)
    expect(at(candles[0].time)).toBe('12:00:00')
    // Open of the first trade, close of the last, extremes across all six.
    expect(candles[0]).toMatchObject({ open: 100, high: 110, low: 98, close: 107 })
  })

  it('a coarser interval never yields MORE candles than a finer one', () => {
    const counts = [60, 120, 300, 600].map((s) => buildCandles(TRADES, s).candles.length)
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1])
  })

  it('total volume is conserved across every timeframe', () => {
    const total = TRADES.reduce((a, t) => a + t.qty, 0)
    for (const sec of [60, 120, 300, 600]) {
      const sum = buildCandles(TRADES, sec).volumes.reduce((a, v) => a + v.value, 0)
      expect(sum).toBe(total)
    }
  })

  it('the first open and last close are identical at every timeframe', () => {
    for (const sec of [60, 120, 300, 600]) {
      const { candles } = buildCandles(TRADES, sec)
      expect(candles[0].open).toBe(100)
      expect(candles[candles.length - 1].close).toBe(107)
    }
  })
})

describe('the series is always safe to hand to the chart', () => {
  it('times are strictly increasing', () => {
    const { candles } = buildCandles(TRADES, 60)
    for (let i = 1; i < candles.length; i++) {
      expect(candles[i].time).toBeGreaterThan(candles[i - 1].time)
    }
  })

  it('unordered input still produces an ordered series', () => {
    const shuffled = [TRADES[4], TRADES[0], TRADES[5], TRADES[2], TRADES[1], TRADES[3]]
    const { candles } = buildCandles(shuffled, 300)
    expect(candles.map((c) => at(c.time))).toEqual(['12:00:00', '12:05:00'])
  })

  it('no trades gives no candles rather than a phantom bar', () => {
    expect(buildCandles([], 300).candles).toEqual([])
  })

  it('a nonsense interval yields nothing instead of dividing by zero', () => {
    expect(buildCandles(TRADES, 0).candles).toEqual([])
    expect(buildCandles(TRADES, -60).candles).toEqual([])
    expect(buildCandles(TRADES, Number.NaN).candles).toEqual([])
  })

  it('skips malformed points rather than emitting NaN times', () => {
    const dirty = [...TRADES, { t: Number.NaN, price: 5, qty: 1 }, { t: T('12:01:00'), price: Number.NaN, qty: 1 }]
    const { candles } = buildCandles(dirty, 300)
    expect(candles.every((c) => Number.isFinite(c.time) && Number.isFinite(c.close))).toBe(true)
  })
})

describe('the visible window follows the MOST RECENT data', () => {
  it('always includes the newest candle', () => {
    for (const n of [1, 2, 5, 20, 90, 500]) {
      const r = visibleRange(n, 25)!
      expect(r.to).toBeGreaterThanOrEqual(n - 1)
    }
  })

  it('a long history scrolls, showing the newest bars flush right', () => {
    const r = visibleRange(500, 25)!
    expect(r.to).toBe(499) // the latest candle
    expect(r.from).toBe(475) // 25 bars back, older ones off-screen left
  })

  it('does NOT strand the view on an old slice when history is long', () => {
    const r = visibleRange(500, 25)!
    expect(r.from).toBeGreaterThan(400) // nowhere near the start of the series
  })

  it('few candles are centred, not pinned to the right of an empty chart', () => {
    const r = visibleRange(2, 25)!
    expect(r.from).toBeLessThan(0) // padding on the left
    expect(r.to).toBeGreaterThan(1) // and on the right
    expect(r.from + r.to).toBeCloseTo(1, 10) // symmetric about the two candles
  })

  it('exactly filling the canvas shows every candle', () => {
    const r = visibleRange(25, 25)!
    expect(r.from).toBe(0)
    expect(r.to).toBe(24)
  })

  it('no candles means no range to set', () => {
    expect(visibleRange(0, 25)).toBeNull()
  })

  it('a degenerate capacity still produces a usable range', () => {
    expect(visibleRange(10, 0)).not.toBeNull()
    expect(visibleRange(10, -5)).not.toBeNull()
  })
})
