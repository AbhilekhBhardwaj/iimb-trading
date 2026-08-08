/**
 * Presentation logic for the market maker's risk desk.
 *
 * Pure and DOM-free so the confirm dialog's wording — the thing standing
 * between a click and somebody's position being closed — is pinned by tests
 * rather than by eye.
 */

import { type ConfirmLine } from './orderConfirm'
import { inr, usd } from './format'

/** The subset of a liquidatable row this module needs. */
export interface RiskRow {
  username: string
  ticker: string
  side: 'long' | 'short'
  qty: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number
  pastByUsd: number
  pastByPct: number
  notionalBasisInr: number
}

/** `+12.4%` past, or `−3.1%` when the position has not crossed yet. */
export function pastLabel(pastByPct: number): string {
  if (!Number.isFinite(pastByPct)) return '—'
  const rounded = Math.round(pastByPct * 10) / 10
  if (rounded === 0) return '0.0%'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(1)}%`
}

/**
 * Whether this row has actually crossed its threshold.
 *
 * The desk may close anything it judges necessary, so the list is a reference
 * rather than a permission check — but a row that has NOT crossed should look
 * different from one that has, or the distinction disappears at a glance.
 */
export function hasCrossed(row: Pick<RiskRow, 'pastByUsd'>): boolean {
  return row.pastByUsd > 0
}

/** The side traded to close: sell out a long, buy back a short. */
export function closingSide(row: Pick<RiskRow, 'side'>): 'buy' | 'sell' {
  return row.side === 'long' ? 'sell' : 'buy'
}

/**
 * Rows for the confirmation dialog.
 *
 * Names the account explicitly. This is the one action in the platform where a
 * mis-click destroys somebody else's position, so the dialog leads with WHOSE
 * position it is rather than the instrument.
 */
export function buildLiquidationLines(row: RiskRow): ConfirmLine[] {
  const crossed = hasCrossed(row)
  return [
    { k: 'Account', v: row.username, tone: 'destructive' },
    { k: 'Instrument', v: row.ticker },
    { k: 'Position', v: `${row.side.toUpperCase()} ${Math.abs(row.qty)}` },
    { k: 'Entry', v: usd(row.entryPrice) },
    { k: 'Mark', v: usd(row.markPrice) },
    { k: 'Liquidation', v: usd(row.liquidationPrice) },
    {
      k: crossed ? 'Past threshold' : 'Short of threshold',
      v: pastLabel(row.pastByPct),
      tone: crossed ? 'destructive' : undefined,
    },
    { k: 'Cost basis', v: inr(row.notionalBasisInr) },
    { k: 'Closes with', v: `${closingSide(row).toUpperCase()} at market` },
  ]
}

/**
 * The warning beneath the rows.
 *
 * A discretionary close — one where the position has NOT crossed — says so
 * plainly. The server permits it; the dialog should not let it pass unnoticed.
 */
export function liquidationWarning(row: RiskRow): string {
  const base =
    `This force-closes ${row.username}'s position at market, immediately and irreversibly. ` +
    `It settles like any other trade: real fill, real commission, real P&L.`
  return hasCrossed(row)
    ? `${base} The mark has passed the liquidation price.`
    : `${base} NOTE: this position has NOT crossed its liquidation price — closing it is your ` +
        `discretionary call, and will be logged as such.`
}
