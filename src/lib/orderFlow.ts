/**
 * The order flow, extracted so every surface shares ONE implementation.
 *
 * The Terminal's order window and the Portfolio's per-position Close action must
 * behave identically — same confirm dialog, same placement path, same post-trade
 * result with its P&L breakdown and slippage nudge. Rather than reimplement any
 * of that on the Portfolio, both pages build their dialogs here.
 *
 * Pure and deterministic: no React, no network, no clock. The caller does the
 * `api.placeOrder` round-trip and passes the response in, which is what makes
 * the whole decision tree — rest vs toast vs dialog — directly testable.
 */

import { type CashPosition, type CommissionTerms } from '@iimb-trading/engine'
import { inr, usd } from './format'
import { type ConfirmLine, orderPnlLines } from './orderConfirm'
import { type OrderRejection, rejectionMessage } from './orderRejection'
import { averageFillPrice, type Fill, slippageNudge } from './slippage'

type Side = 'buy' | 'sell'
type OrderType = 'limit' | 'market'

/** The order as the user configured it, before it is sent. */
export interface OrderTerms {
  ticker: string
  side: Side
  type: OrderType
  qty: number
  /** Limit price, or the current mark for a market order. */
  price: number
  leverage: number
  /** Margin this order needs, INR. Negative/near-zero when it frees margin. */
  requiredInr: number
  /** Estimated liquidation price after the fill, or null. */
  liq: number | null
  /** Whether the order leaves the position flat. */
  closes: boolean
}

/** Everything about the market and account the dialogs need. */
export interface MarketContext {
  /** The position as it stands BEFORE this order. */
  position: CashPosition | null
  usdInrRate: number
  commission: CommissionTerms
  /** The round's slippage-nudge toggle. */
  slippageEnabled: boolean
}

/** What the server said about the order. */
export interface PlacementResult {
  /** False when the order was turned away before reaching the book. */
  accepted?: boolean
  reason?: string
  rejection?: OrderRejection
  trades?: Fill[]
  bestPriceAtSubmit?: number
}

// A position-reducing order frees margin (requiredMargin < 0); never show that as
// a negative "required" figure. A closing order leaves no position, hence no liq.
export const marginLabel = (requiredInr: number): string =>
  requiredInr > 1 ? inr(requiredInr) : '— (frees margin)'

// liq === 0 is mathematically correct and unique to a fully-collateralized 1×
// long (E·(1 − 1/1) = 0): it can only be liquidated if the stock itself hits $0.
// Show that explicitly rather than a bare "$0.00" that reads like a bug.
export const liqLabel = (closes: boolean, liq: number | null): string =>
  closes ? 'Flat after close' : liq === null ? '—' : liq <= 0 ? 'N/A — fully collateralized' : usd(liq)

/**
 * The order that would close a position: SELL a long, BUY a short, for its full
 * size. Null when flat or absent — there is nothing to close.
 *
 * Quantity is the default only; a caller may reduce it for a partial close.
 */
export function closingOrderFor(
  position: { qty: number } | null | undefined,
): { side: Side; qty: number } | null {
  if (!position || !Number.isFinite(position.qty) || position.qty === 0) return null
  return { side: position.qty > 0 ? 'sell' : 'buy', qty: Math.abs(position.qty) }
}

/** Rows for the pre-trade confirm dialog. */
export function buildConfirmLines(o: OrderTerms, ctx: MarketContext): ConfirmLine[] {
  return [
    { k: 'Instrument', v: o.ticker },
    { k: 'Side', v: o.side.toUpperCase(), tone: o.side === 'buy' ? 'up' : 'destructive' },
    { k: 'Type', v: o.type.toUpperCase() },
    { k: 'Quantity', v: String(o.qty) },
    // A market order has no guaranteed price; show the current mark as an
    // estimate rather than the bare word "MARKET". If it walks the book the real
    // average lands in the post-trade dialog, with the nudge.
    { k: 'Price', v: o.type === 'market' ? `~${usd(o.price)} at execution` : usd(o.price) },
    { k: 'Leverage', v: `${o.leverage}x` },
    { k: 'Margin Required', v: marginLabel(o.requiredInr) },
    { k: 'Est. Liquidation', v: liqLabel(o.closes, o.liq) },
    // Realized-P&L preview. Closing or reducing shows Gross / Commission / Net;
    // an opening fill shows the commission alone. Empty otherwise.
    ...orderPnlLines(
      ctx.position,
      o.side === 'buy' ? o.qty : -o.qty,
      o.price,
      ctx.usdInrRate,
      o.leverage,
      ctx.commission,
    ),
  ]
}

/** The subset of a working order the cancel dialog needs. */
export interface CancellableOrder {
  ticker: string
  side: Side
  type: OrderType
  price: number | null
  qty: number
  remainingQty: number
}

/**
 * Rows for the cancel-confirmation dialog.
 *
 * Shows REMAINING quantity prominently: a partially-filled order only cancels
 * what is left, and the filled part stays done. Anything already filled is
 * called out explicitly so nobody expects cancelling to unwind it.
 */
export function buildCancelLines(o: CancellableOrder): ConfirmLine[] {
  const filled = o.qty - o.remainingQty
  const lines: ConfirmLine[] = [
    { k: 'Instrument', v: o.ticker },
    { k: 'Side', v: o.side.toUpperCase(), tone: o.side === 'buy' ? 'up' : 'destructive' },
    { k: 'Type', v: o.type.toUpperCase() },
    { k: 'Price', v: o.price === null ? '—' : usd(o.price) },
    { k: 'Cancelling', v: `${o.remainingQty} of ${o.qty}` },
  ]
  if (filled > 0) {
    lines.push({ k: 'Already filled', v: `${filled} — stays filled`, tone: 'destructive' })
  }
  return lines
}

/** What should happen after the server accepted the order. */
export type TradeOutcome =
  /** The order never reached the book. Shown as a modal, never a fading toast. */
  | { kind: 'reject'; title: string; detail: string; code: string }
  | { kind: 'toast'; ok: true; title: string; detail: string }
  | { kind: 'dialog'; title: string; lines: ConfirmLine[]; note: string | null; filledQty: number }

/**
 * Turn an accepted placement into the outcome the UI shows.
 *
 * Rejected → an error dialog, always. Nothing filled → the order is resting, a
 * toast. Filled with nothing to teach →
 * a toast. Filled with a realized breakdown or a slippage nudge → the result
 * dialog. Everything is measured on what ACTUALLY filled: the volume-weighted
 * average across however many levels the order touched, and only the quantity
 * that traded.
 */
export function buildTradeOutcome(
  o: OrderTerms,
  ctx: MarketContext,
  res: PlacementResult,
): TradeOutcome {
  // REJECTION FIRST, before anything reads `trades`. A rejected order has no
  // fills, so every later branch would read it as "resting on the book" — which
  // is precisely how a bounced order came to look like a successful one. Making
  // this a case of the shared outcome means no caller can forget to check.
  const rejected = rejectionMessage(res)
  if (rejected) return { kind: 'reject', ...rejected }

  const fills = res.trades ?? []
  const filled = fills.reduce((a, t) => a + t.qty, 0)
  if (filled === 0) {
    return { kind: 'toast', ok: true, title: 'Order resting', detail: `${o.qty} @ ${usd(o.price)} on the book` }
  }

  const avg = averageFillPrice(fills)
  const avgPrice = avg?.avgFillPrice ?? o.price
  const pnlLines = avg
    ? orderPnlLines(
        ctx.position,
        o.side === 'buy' ? avg.filledQty : -avg.filledQty,
        avg.avgFillPrice,
        ctx.usdInrRate,
        o.leverage,
        ctx.commission,
      )
    : []
  const note = slippageNudge({
    orderType: o.type,
    side: o.side,
    bestPrice: res.bestPriceAtSubmit,
    fills,
    enabled: ctx.slippageEnabled,
  })

  const partial = filled < o.qty
  if (pnlLines.length === 0 && !note) {
    return {
      kind: 'toast',
      ok: true,
      title: partial ? 'Partial fill' : 'Order filled',
      detail: `${filled} @ avg ${usd(avgPrice)}`,
    }
  }
  return {
    kind: 'dialog',
    title: partial ? 'Partial Fill' : 'Order Filled',
    filledQty: filled,
    lines: [
      { k: 'Instrument', v: o.ticker },
      { k: 'Side', v: o.side.toUpperCase(), tone: o.side === 'buy' ? 'up' : 'destructive' },
      { k: 'Filled', v: partial ? `${filled} of ${o.qty}` : String(filled) },
      { k: 'Avg Fill', v: usd(avgPrice) },
      ...pnlLines,
    ],
    note,
  }
}
