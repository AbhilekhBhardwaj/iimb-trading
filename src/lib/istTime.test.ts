import { describe, expect, it } from 'vitest'
import { buildCandles, type PricePoint } from './chartSync'
import { istChartTime, istDateTime, istTime } from './format'

/** A known instant: 2026-08-08T09:02:07Z is 14:32:07 IST. */
const KNOWN_UTC = Date.parse('2026-08-08T09:02:07Z')

// ---------------------------------------------------------------------------

describe('a known UTC instant displays as IST', () => {
  it('09:02:07 UTC reads as 14:32:07', () => {
    expect(istTime(KNOWN_UTC)).toBe('14:32:07')
  })

  it('shifts by exactly 5 hours 30 minutes', () => {
    const utc = new Date(KNOWN_UTC).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour12: false })
    expect(utc).toBe('09:02:07')
    expect(istTime(KNOWN_UTC)).toBe('14:32:07') // +5:30
  })

  it('rolls past midnight correctly', () => {
    // 20:00 UTC is 01:30 IST the NEXT day.
    expect(istTime(Date.parse('2026-08-08T20:00:00Z'))).toBe('01:30:00')
    expect(istDateTime(Date.parse('2026-08-08T20:00:00Z'))).toBe('09 Aug 01:30:00')
  })

  it('handles the half-hour offset, not just whole hours', () => {
    expect(istTime(Date.parse('2026-08-08T00:00:00Z'))).toBe('05:30:00')
    expect(istTime(Date.parse('2026-08-08T18:30:00Z'))).toBe('00:00:00')
  })

  it('is the same offset in January and July — India has no DST', () => {
    expect(istTime(Date.parse('2026-01-15T12:00:00Z'))).toBe('17:30:00')
    expect(istTime(Date.parse('2026-07-15T12:00:00Z'))).toBe('17:30:00')
  })

  it('does NOT follow the machine locale — it is pinned to Asia/Kolkata', () => {
    // Whatever this runner's zone is, the answer is the IST one.
    expect(istTime(KNOWN_UTC)).toBe('14:32:07')
  })

  it('formats a date-stamped row for history tables', () => {
    expect(istDateTime(KNOWN_UTC)).toBe('08 Aug 14:32:07')
  })

  it('can omit seconds where the row is tight', () => {
    expect(istTime(KNOWN_UTC, false)).toBe('14:32')
  })

  it('degrades instead of printing "Invalid Date"', () => {
    expect(istTime(Number.NaN)).toBe('—')
    expect(istDateTime(Number.NaN)).toBe('—')
  })
})

describe('the chart axis label', () => {
  it('takes epoch SECONDS and renders IST', () => {
    expect(istChartTime(KNOWN_UTC / 1000)).toBe('14:32')
  })

  it('agrees with the millisecond formatter for the same instant', () => {
    expect(istChartTime(KNOWN_UTC / 1000, true)).toBe(istTime(KNOWN_UTC))
  })

  it('a UTC bucket boundary lands on a ROUND IST time', () => {
    // 09:00:00 UTC -> 14:30 IST. Both are 5-minute boundaries.
    expect(istChartTime(Date.parse('2026-08-08T09:00:00Z') / 1000)).toBe('14:30')
    expect(istChartTime(Date.parse('2026-08-08T09:05:00Z') / 1000)).toBe('14:35')
    expect(istChartTime(Date.parse('2026-08-08T09:10:00Z') / 1000)).toBe('14:40')
  })
})

describe('BUCKETING IS UNCHANGED — the timeframe fix still holds', () => {
  /**
   * IST is +5:30, i.e. 19,800 seconds, which divides every interval the chart
   * offers. So a UTC bucket boundary is also an IST bucket boundary, and the
   * display change cannot move a candle into a different bucket.
   */
  it('19,800s divides every interval we offer', () => {
    for (const sec of [60, 120, 300, 600]) expect(19_800 % sec).toBe(0)
  })

  const T = (hhmmss: string) => Date.parse(`2026-08-08T${hhmmss}Z`)
  const p = (hhmmss: string, price: number): PricePoint => ({ t: T(hhmmss), price, qty: 1 })

  it('candle times are still true UTC epoch seconds, not shifted', () => {
    const { candles } = buildCandles([p('09:02:07', 100)], 300)
    // The stored value is the UTC bucket, 09:00:00Z.
    expect(candles[0].time).toBe(Date.parse('2026-08-08T09:00:00Z') / 1000)
    // Only the LABEL is IST.
    expect(istChartTime(candles[0].time)).toBe('14:30')
  })

  it('trades either side of an IST-visible boundary bucket exactly as before', () => {
    // 14:34:59 IST and 14:35:01 IST -> 09:04:59Z and 09:05:01Z.
    const { candles } = buildCandles([p('09:04:59', 100), p('09:05:01', 110)], 300)
    expect(candles).toHaveLength(2)
    expect(istChartTime(candles[0].time)).toBe('14:30')
    expect(istChartTime(candles[1].time)).toBe('14:35')
  })

  it('every bucket is still an exact multiple of the interval', () => {
    const trades = ['09:00:05', '09:02:13', '09:04:59', '09:05:01', '09:07:30'].map((t) => p(t, 100))
    for (const sec of [60, 120, 300, 600]) {
      for (const c of buildCandles(trades, sec).candles) expect(c.time % sec).toBe(0)
    }
  })

  it('the candle COUNT per timeframe is identical to before the IST change', () => {
    const trades = ['09:00:05', '09:02:13', '09:04:59', '09:05:01', '09:07:30'].map((t) => p(t, 100))
    expect(buildCandles(trades, 60).candles).toHaveLength(5)
    expect(buildCandles(trades, 300).candles).toHaveLength(2)
    expect(buildCandles(trades, 600).candles).toHaveLength(1)
  })
})

describe('the other time displays in the app', () => {
  /**
   * Times & Sales, the Admin clock and the Portfolio history rows all used the
   * machine's locale. On a laptop set to IST that happened to be right; on one
   * set to anything else it silently was not. These now go through the same
   * pinned formatter as the chart, so every clock in the app agrees.
   */
  it('Times & Sales style: HH:MM:SS in IST', () => {
    expect(istTime(KNOWN_UTC)).toBe('14:32:07')
  })

  it('Portfolio history style: day, month and time in IST', () => {
    expect(istDateTime(KNOWN_UTC)).toBe('08 Aug 14:32:07')
  })

  it('all three displays agree on the same instant', () => {
    const t = istTime(KNOWN_UTC)
    expect(istDateTime(KNOWN_UTC)).toContain(t)
    expect(istChartTime(KNOWN_UTC / 1000, true)).toBe(t)
  })
})
