/**
 * Slippage nudge for MARKET orders.
 *
 * A market order takes whatever the book offers, walking to worse levels once
 * the top level is exhausted. This module measures how much that walk cost
 * against the best price that was showing at submit time, and phrases it as a
 * teaching nudge toward limit orders.
 *
 * Pure and deterministic: no clock, no I/O, no React. Prices are USD, matching
 * the rest of the instrument-price surface.
 *
 * Deliberate non-goals:
 *   - A LIMIT order never produces a nudge. Its price is already guaranteed, so
 *     any difference from top-of-book is the trader's own choice, not slippage.
 *   - Price improvement is not a nudge. If the average fill came out BETTER than
 *     the best showing price, there is nothing to warn about.
 *   - An unfilled order produces nothing: with no fills there is no average.
 */

import { usd } from './simulation'

type Side = 'buy' | 'sell'
type OrderType = 'market' | 'limit'

/** One executed fill. Matches PlaceOrderResult.trades. */
export interface Fill {
  price: number
  qty: number
}

/** One aggregated depth level. Matches DepthLevel. */
export interface Level {
  price: number
  qty: number
}

/**
 * Below this, the nudge is suppressed. `usd()` renders to 2dp, so anything under
 * half a cent would read "could have saved you $0.00" — technically non-zero,
 * useless to a trader, and it would fire on floating-point dust.
 */
export const MIN_NUDGE_USD = 0.005

export interface Slippage {
  /** Volume-weighted average price actually transacted, USD. */
  avgFillPrice: number
  /** Best price showing at submit time — best ask to buy, best bid to sell. */
  bestPrice: number
  /** Quantity these figures cover (the filled amount, not the ordered amount). */
  filledQty: number
  /** Adverse move per unit, USD. Always > 0 when a Slippage is returned. */
  slippagePerUnit: number
  /** slippagePerUnit × filledQty, USD. Always > 0 when a Slippage is returned. */
  slippageUsd: number
}

/**
 * Top-of-book price a market order would first hit: a buy lifts the best (lowest)
 * ask, a sell hits the best (highest) bid. Null when that side is empty.
 *
 * Depth arrives already sorted best-first — asks ascending, bids descending.
 */
export function bestPriceFrom(
  depth: { bids: Level[]; asks: Level[] } | null | undefined,
  side: Side,
): number | null {
  if (!depth) return null
  const level = side === 'buy' ? depth.asks[0] : depth.bids[0]
  if (!level || !Number.isFinite(level.price) || level.price <= 0) return null
  return level.price
}

/** Volume-weighted average price across fills. Null when nothing filled. */
export function averageFillPrice(fills: Fill[] | null | undefined): { avgFillPrice: number; filledQty: number } | null {
  if (!fills || fills.length === 0) return null
  let notional = 0
  let filledQty = 0
  for (const f of fills) {
    if (!Number.isFinite(f.price) || !Number.isFinite(f.qty) || f.qty <= 0) continue
    notional += f.price * f.qty
    filledQty += f.qty
  }
  if (filledQty <= 0) return null
  return { avgFillPrice: notional / filledQty, filledQty }
}

/**
 * Slippage on an executed order, or null when there is none worth reporting.
 *
 * Adverse direction depends on side: buying, a HIGHER average than the best ask
 * is the loss; selling, a LOWER average than the best bid is. Either way the
 * returned figure is positive, so callers never have to reason about sign.
 */
export function computeSlippage(input: {
  orderType: OrderType
  side: Side
  bestPrice: number | null | undefined
  fills: Fill[] | null | undefined
}): Slippage | null {
  // A limit order's price is guaranteed — never a slippage story.
  if (input.orderType !== 'market') return null
  const { bestPrice } = input
  if (bestPrice === null || bestPrice === undefined || !Number.isFinite(bestPrice) || bestPrice <= 0) return null

  const avg = averageFillPrice(input.fills)
  if (!avg) return null

  // Buying: paid above the best ask. Selling: received below the best bid.
  const slippagePerUnit =
    input.side === 'buy' ? avg.avgFillPrice - bestPrice : bestPrice - avg.avgFillPrice

  // Price improvement, or an exact top-of-book fill, is not a nudge.
  if (slippagePerUnit <= 0) return null

  const slippageUsd = slippagePerUnit * avg.filledQty
  if (slippageUsd < MIN_NUDGE_USD) return null

  return {
    avgFillPrice: avg.avgFillPrice,
    bestPrice,
    filledQty: avg.filledQty,
    slippagePerUnit,
    slippageUsd,
  }
}

/** The nudge sentence for a Slippage, phrased for a trader. */
export function slippageMessage(s: Slippage): string {
  return (
    `Your average fill was ${usd(s.avgFillPrice)}. ` +
    `A limit order at ${usd(s.bestPrice)} could have saved you ${usd(s.slippageUsd)} — ` +
    `though it may not have filled your full quantity.`
  )
}

/**
 * The whole thing end to end: executed order in, nudge sentence out, or null
 * when there is nothing to say. This is what the Terminal calls.
 */
export function slippageNudge(input: {
  orderType: OrderType
  side: Side
  bestPrice: number | null | undefined
  fills: Fill[] | null | undefined
}): string | null {
  const s = computeSlippage(input)
  return s ? slippageMessage(s) : null
}
