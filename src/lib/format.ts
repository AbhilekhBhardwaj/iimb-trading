/**
 * Display formatters — money, percentages, and round names.
 *
 * Split out of simulation.ts, which also exports a React hook that touches
 * `window` — importing a formatter from there dragged the whole browser module
 * in, so pure logic (orderConfirm, slippage) could not be used or tested outside
 * a DOM environment. Nothing here touches React, the DOM, or a clock.
 *
 * simulation.ts re-exports these, so existing `from './simulation'` imports keep
 * working and there is still one definition of each.
 */

const inrFmt0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** Indian-grouped rupee string (e.g. ₹10,24,500). */
export function inr(v: number): string {
  return inrFmt0.format(v)
}

/** Signed rupee string for P&L (e.g. +₹12,340 / −₹4,120). */
export function inrSigned(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${inrFmt0.format(Math.abs(v))}`
}

/** USD price string (e.g. $128.40). */
export function usd(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Compact USD for axis ticks (e.g. $2,648 / $71.2). */
export function usdAxis(v: number): string {
  return v >= 100
    ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${v.toFixed(1)}`
}

/** Signed percent string (e.g. +2.41% / −1.08%). */
export function pct(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${Math.abs(v).toFixed(2)}%`
}

/**
 * Plain-language name for an internal round id: `real-3` → "Round 3",
 * `mock-1` → "Mock Round 1".
 *
 * Numbered from the id's own suffix, NOT from the schedule index — the mock
 * round occupies index 0, so index-based numbering would call `real-3` "Round 4"
 * and the mock round "Round 1". Every surface (Master and teams) uses this, so
 * one round has exactly one name across the app.
 *
 * An id in an unrecognised shape is returned unchanged rather than hidden.
 */
export function roundLabel(id: string): string {
  const mock = /^mock-(\d+)$/.exec(id)
  if (mock) return `Mock Round ${mock[1]}`
  const real = /^real-(\d+)$/.exec(id)
  if (real) return `Round ${real[1]}`
  return id
}

// ---------------------------------------------------------------------------
// Time display — IST
// ---------------------------------------------------------------------------

/**
 * The event runs in Bangalore, so every time a team reads must be IST.
 *
 * Storage and every calculation stay in UTC — trades carry UTC timestamps, the
 * engine buckets on UTC epoch seconds, and nothing here changes that. This is
 * strictly a display layer.
 *
 * Pinned to Asia/Kolkata rather than the machine's locale on purpose: a laptop
 * with its clock set to another zone would otherwise show a team the wrong time
 * for their own fills. India observes no DST (verified: +5:30 in both January
 * and July), so the offset is constant all year.
 */
const IST = 'Asia/Kolkata'

/** `14:32:07` in IST. */
export function istTime(ms: number, withSeconds = true): string {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleTimeString('en-GB', {
    timeZone: IST,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })
}

/** `08 Aug 14:32:07` in IST, for rows that can span days. */
export function istDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  // en-GB renders "08 Aug, 14:32:07"; drop the comma for a tighter table cell.
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: IST,
    hour12: false,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).replace(',', '')
}

/**
 * Axis/crosshair label for lightweight-charts, which takes epoch SECONDS and
 * would otherwise render them in UTC — it has no timezone support of its own.
 *
 * The candle's `time` value is left as true UTC epoch seconds; only the label
 * is translated. That matters because the series must stay monotonically
 * increasing in real time, and because shifting the values themselves is the
 * common workaround that quietly corrupts the data.
 *
 * IST is +5:30, i.e. 19,800s, which divides every interval the chart offers
 * (60/120/300/600), so a UTC bucket boundary is also an IST bucket boundary and
 * labels land on round times.
 */
export function istChartTime(epochSeconds: number, withSeconds = false): string {
  return istTime(epochSeconds * 1000, withSeconds)
}
