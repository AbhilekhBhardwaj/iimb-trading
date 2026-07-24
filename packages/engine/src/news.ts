import {
  NEWS_OVERSHOOT,
  NEWS_RETRACE_SECONDS,
  NEWS_RISE_SECONDS,
  NEWS_WINDOW_SECONDS,
} from './config'
import type { Stock } from './price'

/**
 * The price impact a news item targets, expressed as decimal deltas
 * (e.g. -0.06 = a 6% drop once fully settled). Every field is optional in
 * spirit: absent tickers/sectors simply contribute nothing.
 */
export interface NewsImpact {
  /** Per-ticker delta for the directly-named stock(s). */
  primary: Record<string, number>
  /** Per-ticker delta for spillover onto related stocks. */
  related: Record<string, number>
  /** Per-sector delta applied to every stock in the sector. */
  sector: Record<string, number>
  /** Market-wide delta applied to every stock. */
  market: number
}

export interface NewsItem {
  id: string
  headline: string
  body: string
  /** When the item drops in the event timeline, in real seconds. */
  fireAtSeconds: number
  impact: NewsImpact
  /** A red herring: looks impactful but moves the price negligibly. */
  isHerring: boolean
}

/**
 * The impact envelope: given seconds elapsed since a news item fired, returns a
 * multiple of that item's target delta. Piecewise-linear through the phases
 * described in config.ts.
 *
 *   secondsSinceFire < 0        -> 0 (not fired yet)
 *   [0, WINDOW)                 -> 0 (reaction window; price must not move)
 *   [WINDOW, WINDOW+RISE)       -> 0 .. OVERSHOOT
 *   [WINDOW+RISE, +RETRACE)     -> OVERSHOOT .. 1
 *   settled                     -> 1
 *
 * Returns exactly 0 across the whole window (including both endpoints), so a
 * price overlaid with news is bit-for-bit unchanged until the window closes.
 */
export function impactEnvelope(secondsSinceFire: number): number {
  const windowEnd = NEWS_WINDOW_SECONDS
  const riseEnd = windowEnd + NEWS_RISE_SECONDS
  const retraceEnd = riseEnd + NEWS_RETRACE_SECONDS
  const peak = NEWS_OVERSHOOT

  if (secondsSinceFire < windowEnd) {
    // Not yet fired, or inside the reaction window: no movement at all.
    return 0
  }
  if (secondsSinceFire < riseEnd) {
    // Ramp linearly from 0 up to the overshoot peak.
    const progress = (secondsSinceFire - windowEnd) / NEWS_RISE_SECONDS
    return peak * progress
  }
  if (secondsSinceFire < retraceEnd) {
    // Retrace linearly from the overshoot peak back down to the target (1).
    const progress = (secondsSinceFire - riseEnd) / NEWS_RETRACE_SECONDS
    return peak + (1 - peak) * progress
  }
  // Fully settled at the target delta.
  return 1
}

/**
 * The target delta a single news item contributes to one stock, summed across
 * every channel that touches it: primary ticker, related ticker, its sector,
 * and the market-wide term. Herrings contribute nothing.
 *
 * This is the fully-settled delta (before the time envelope is applied).
 */
export function stockTargetDelta(item: NewsItem, ticker: string, sector: string): number {
  if (item.isHerring) return 0
  const primary = item.impact.primary[ticker] ?? 0
  const related = item.impact.related[ticker] ?? 0
  const sectorDelta = item.impact.sector[sector] ?? 0
  return primary + related + sectorDelta + item.impact.market
}

/**
 * Total news effect fraction for a stock at time `tSeconds`, composed across
 * ALL active news items. Deltas add (they do not overwrite), and each item's
 * contribution is scaled by its own time envelope, so two items on the same
 * stock combine (+0.05 and +0.03 settle to +0.08).
 *
 * The returned value is a fraction: apply it as price * (1 + effect).
 */
export function newsEffectForStock(
  news: readonly NewsItem[],
  ticker: string,
  sector: string,
  tSeconds: number,
): number {
  let effect = 0
  for (const item of news) {
    const delta = stockTargetDelta(item, ticker, sector)
    if (delta === 0) continue
    effect += delta * impactEnvelope(tSeconds - item.fireAtSeconds)
  }
  return effect
}

/**
 * Overlay a news effect fraction onto a base (GBM) price level. News shifts the
 * level multiplicatively; the underlying GBM walk still supplies the noise.
 */
export function applyNewsEffect(basePrice: number, effectFraction: number): number {
  return basePrice * (1 + effectFraction)
}

/**
 * Convenience: the news-adjusted price for a stock at time `tSeconds`, treating
 * stock.price as the current GBM baseline. Pure — does not mutate the stock.
 */
export function newsAdjustedPrice(
  stock: Stock,
  news: readonly NewsItem[],
  tSeconds: number,
): number {
  const effect = newsEffectForStock(news, stock.ticker, stock.sector, tSeconds)
  return applyNewsEffect(stock.price, effect)
}
