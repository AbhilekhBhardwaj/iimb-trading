/**
 * Realized-P&L lines for the terminal's order-confirmation popup.
 *
 * Presentation only — every rupee figure comes from the engine's
 * `closingPnlBreakdown`, which is the same `applyCashFill` math the server
 * settles with, so the popup cannot promise a number the fill will not deliver.
 *
 * Two rules the display follows:
 *
 *   - Gross and Net appear ONLY for a fill that closes or reduces a position.
 *     An opening or adding fill realizes nothing, so there is nothing to split.
 *   - The Commission line appears ONLY while the round's commission toggle is
 *     on — but it appears on EVERY fill, including opens and adds, because the
 *     engine charges commission on every fill (see applyPosition: "Commission
 *     alone moves realized even on an opening fill"). An opening buy therefore
 *     shows a lone Commission line: a real cost, with no realized P&L to net
 *     it against yet.
 *   - That toggle governs whether commission is actually CHARGED (see
 *     tradingService.settleFill), so when it is off the commission really is
 *     zero and Net equals Gross — hiding the line states a true thing rather
 *     than concealing a deduction.
 */

import {
  closingPnlBreakdown,
  commissionInrFor,
  FLAT_CASH,
  type CashPosition,
  type ClosingPnlBreakdown,
  type CommissionTerms,
} from '@iimb-trading/engine'
import { inrSigned } from './format'

/** One key/value row in the confirmation dialog. */
export interface ConfirmLine {
  k: string
  v: string
  tone?: 'up' | 'destructive'
}

/** Green for a gain, red for a loss, default for exactly zero. */
function toneFor(v: number): 'up' | 'destructive' | undefined {
  return v > 0 ? 'up' : v < 0 ? 'destructive' : undefined
}

/** The fields of the snapshot's PositionView that the cash math needs. */
export interface PositionViewLike {
  qty: number
  avgPrice: number
  leverage: number
  /** UNSIGNED cost basis, as the API exposes it for display. */
  costBasisInr: number
}

/**
 * Adapt a snapshot position to the engine's `CashPosition`.
 *
 * The API exposes `costBasisInr` unsigned because it is a display figure, while
 * the engine's `notionalBasisInr` is signed like `qty`. Re-signing it here is
 * what keeps a short's P&L from coming out backwards. A flat or absent position
 * is null — there is nothing to close.
 */
export function toCashPosition(position: PositionViewLike | null | undefined): CashPosition | null {
  if (!position || position.qty === 0) return null
  return {
    qty: position.qty,
    avgPrice: position.avgPrice,
    notionalBasisInr: Math.abs(position.costBasisInr) * Math.sign(position.qty),
    leverage: position.leverage,
  }
}

/**
 * The Commission row. Rendered as a negative because it is a charge, even
 * though the underlying figure is a positive cost.
 */
function commissionLine(commissionInr: number): ConfirmLine {
  return { k: 'Commission', v: inrSigned(-commissionInr), tone: toneFor(-commissionInr) }
}

/**
 * Render a closing breakdown as dialog rows. Null breakdown (an opening or
 * adding fill) produces no rows at all — see `orderPnlLines` for the lone
 * Commission row that case gets instead.
 */
export function pnlBreakdownLines(
  breakdown: ClosingPnlBreakdown | null,
  commissionEnabled: boolean,
): ConfirmLine[] {
  if (!breakdown) return []

  const lines: ConfirmLine[] = [
    { k: 'Gross P&L', v: inrSigned(breakdown.grossPnlInr), tone: toneFor(breakdown.grossPnlInr) },
  ]
  if (commissionEnabled) lines.push(commissionLine(breakdown.commissionInr))
  lines.push({ k: 'Net P&L', v: inrSigned(breakdown.netPnlInr), tone: toneFor(breakdown.netPnlInr) })
  return lines
}

/**
 * The Terminal's entry point: position + order → dialog rows.
 *
 * `signedQty` is > 0 for a buy and < 0 for a sell. Closing or reducing gives the
 * full Gross / Commission / Net split; opening or adding gives a lone Commission
 * row, since commission is charged there too but nothing is realized yet. An
 * unusable quantity or price yields no rows.
 */
export function orderPnlLines(
  position: CashPosition | null,
  signedQty: number,
  price: number,
  usdInrRate: number,
  fillLeverage: number,
  commission: CommissionTerms,
): ConfirmLine[] {
  if (!Number.isFinite(signedQty) || signedQty === 0) return []
  if (!Number.isFinite(price) || price <= 0) return []

  const breakdown = closingPnlBreakdown(
    position ?? FLAT_CASH,
    signedQty,
    price,
    usdInrRate,
    fillLeverage,
    commission.rate,
  )
  if (breakdown) return pnlBreakdownLines(breakdown, commission.enabled)

  // Opening or adding: nothing realized to split, but the fill IS still charged.
  // With the toggle off the charge still happens — it is simply not itemised.
  if (!commission.enabled) return []
  return [commissionLine(commissionInrFor(signedQty, price, usdInrRate, commission.rate))]
}
