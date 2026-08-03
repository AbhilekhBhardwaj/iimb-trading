/**
 * Pure constants/formatters shared between Terminal and the lazily-loaded
 * PriceChart. Kept dependency-free (no React, no lightweight-charts) so it can
 * be imported by both the main bundle and the chart chunk without pulling the
 * charting library into the initial download.
 */
export const UP = '#22c55e'
export const DOWN = '#d4183d'

export const usd = (v: number) =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const TIMEFRAMES = [
  { k: '1min', s: 60 },
  { k: '2min', s: 120 },
  { k: '5min', s: 300 },
  { k: '10min', s: 600 },
] as const
export type TF = (typeof TIMEFRAMES)[number]['k']

/** Candles to span in the fetch window (interval × this). Keeps a real series in view. */
export const CANDLE_SPAN = 90
export const intervalOf = (tf: TF) => TIMEFRAMES.find((t) => t.k === tf)!.s
