/**
 * Which fundamentals periods a team may see, and how to present them.
 *
 * The reveal rule is deliberately simple and UNCAPPED: round N reveals period
 * N. Round 1 shows Base + P1, Round 2 adds P2, Round 5 adds P5, and so on for
 * however many rounds the Master actually starts. There is no hardcoded round
 * limit anywhere in this module — the schedule-extension feature can create
 * real-21 and beyond, and the reveal keeps pace on its own. If the data book
 * runs out first, the filter simply returns everything that exists.
 *
 * Cumulative and monotonic, like Daily News: a period once revealed is never
 * hidden again, including when a round ends and before the next one starts.
 */

/** One stored data point. `periodIndex` 0 = Base, N = PN. */
export interface FundamentalPoint {
  ticker: string
  metric: string
  periodIndex: number
  value: number
}

/** Display order and formatting for the metrics, top to bottom. */
export const METRIC_ROWS = [
  { key: 'revenue', label: 'Revenue', unit: '$mm' },
  { key: 'ebitda_margin', label: 'EBITDA Margin', unit: '%' },
  { key: 'pat_margin', label: 'PAT Margin', unit: '%' },
  { key: 'eps', label: 'EPS', unit: '$' },
  { key: 'debt_equity', label: 'Debt / Equity', unit: 'x' },
  // Only SPY carries this; the row is omitted for companies.
  { key: 'index_level', label: 'S&P 500 Index Level', unit: 'idx' },
] as const

/**
 * The highest period index revealed by a given round.
 *
 * `real-N` reveals through period N. A mock round reveals only the Base period
 * — practice should not leak the first real data point. No active round leaves
 * whatever was already revealed, which for a fresh event is Base alone.
 *
 * Returns a number with NO upper bound. Clamping to the data book's length is
 * not done here on purpose: it would bake "20" into the rule, and the rule is
 * that there is no limit.
 */
export function revealedThroughPeriod(roundId: string | null | undefined): number {
  if (!roundId) return 0
  const real = /^real-(\d+)$/.exec(roundId)
  if (real) return Number(real[1])
  return 0 // mock-N, or any id we do not recognise: Base only
}

/**
 * Keep only the points a team may currently see.
 *
 * Filters on period, never on ticker or metric, so a caller that asks for one
 * instrument gets every metric it has.
 */
export function revealedPoints(
  points: readonly FundamentalPoint[],
  throughPeriod: number,
): FundamentalPoint[] {
  return points.filter((p) => p.periodIndex <= throughPeriod)
}

/** `Base`, `P1`, `P2`… */
export function periodLabel(periodIndex: number): string {
  return periodIndex === 0 ? 'Base' : `P${periodIndex}`
}

/**
 * The period columns to render, ascending, derived from the data actually
 * present rather than from a fixed range — so the table never shows an empty
 * column for a period the data book does not have.
 */
export function periodColumns(points: readonly FundamentalPoint[]): number[] {
  return [...new Set(points.map((p) => p.periodIndex))].sort((a, b) => a - b)
}

/** The metric rows to render for this instrument, in display order. */
export function metricRowsFor(points: readonly FundamentalPoint[]): typeof METRIC_ROWS[number][] {
  const present = new Set(points.map((p) => p.metric))
  return METRIC_ROWS.filter((m) => present.has(m.key))
}

/** Value lookup, or undefined when that cell has no data. */
export function valueAt(
  points: readonly FundamentalPoint[],
  metric: string,
  periodIndex: number,
): number | undefined {
  return points.find((p) => p.metric === metric && p.periodIndex === periodIndex)?.value
}

/**
 * Format a value for its metric. Margins are stored as fractions (0.3593) and
 * shown as percentages; revenue is large and reads better without decimals.
 */
export function formatValue(metric: string, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  switch (metric) {
    case 'revenue':
      return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    case 'ebitda_margin':
    case 'pat_margin':
      return `${(value * 100).toFixed(2)}%`
    case 'eps':
      return `$${value.toFixed(2)}`
    case 'debt_equity':
      return value.toFixed(2)
    case 'index_level':
      return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
    default:
      return String(value)
  }
}
