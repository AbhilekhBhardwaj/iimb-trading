/**
 * Leverage selection, with a gated danger tier.
 *
 * 1x–5x behave like any toggle: click, applied. 6x and 7x do NOT apply on
 * click — they stage a pending selection that only becomes real once the trader
 * confirms a warning. Cancelling reverts to whatever was selected before, so a
 * mis-click can never silently arm a position that a 15% move would erase.
 *
 * The state machine lives here, apart from React, because "did cancelling
 * actually revert it?" is the question that matters and it should be answerable
 * by a test rather than by clicking around a live terminal.
 */

import { liquidationPrice } from '@iimb-trading/engine'
import { inr, usd } from './format'
import { type ConfirmLine } from './orderConfirm'

/** Every level the order window offers. */
export const LEVERAGE_LEVELS = [1, 2, 3, 4, 5, 6, 7] as const
export type LeverageLevel = (typeof LEVERAGE_LEVELS)[number]

/** Highest level that applies on a single click. Above this, confirmation. */
export const MAX_UNGATED_LEVERAGE = 5

/** Is this level behind the danger-zone confirmation? */
export function isDangerLeverage(level: number): boolean {
  return level > MAX_UNGATED_LEVERAGE
}

/** Is this a level the order window actually offers? */
export function isSelectableLeverage(level: number): level is LeverageLevel {
  return (LEVERAGE_LEVELS as readonly number[]).includes(level)
}

/**
 * The adverse move, in percent, that wipes the position out entirely.
 *
 * Exactly 100/L: the engine liquidates at E·(1 − 1/L) for a long and E·(1 + 1/L)
 * for a short, so this is not an approximation — it is the same number the
 * liquidation engine will use.
 */
export function wipeoutMovePct(level: number): number {
  return 100 / level
}

// ---------------------------------------------------------------------------
// The selection state machine
// ---------------------------------------------------------------------------

export interface LeverageSelection {
  /** What an order placed right now would actually use. */
  applied: LeverageLevel
  /** Staged, awaiting confirmation. Null when nothing is pending. */
  pending: LeverageLevel | null
}

export const INITIAL_LEVERAGE: LeverageSelection = { applied: 1, pending: null }

/**
 * The user clicked a level.
 *
 * Safe levels apply at once. Danger levels stage instead, leaving `applied`
 * untouched — this is the whole point: until confirm() runs, an order still
 * goes out at the OLD leverage.
 */
export function selectLeverage(state: LeverageSelection, level: number): LeverageSelection {
  if (!isSelectableLeverage(level)) return state // ignore anything off the scale
  // Re-clicking the level already in force is a no-op, not a fresh warning.
  if (level === state.applied) return { applied: state.applied, pending: null }
  if (isDangerLeverage(level)) return { applied: state.applied, pending: level }
  return { applied: level, pending: null }
}

/** The trader accepted the warning. The staged level becomes real. */
export function confirmLeverage(state: LeverageSelection): LeverageSelection {
  if (state.pending === null) return state
  return { applied: state.pending, pending: null }
}

/** The trader backed out. Revert to whatever was selected before. */
export function cancelLeverage(state: LeverageSelection): LeverageSelection {
  return { applied: state.applied, pending: null }
}

// ---------------------------------------------------------------------------
// The warning itself
// ---------------------------------------------------------------------------

/** What the order looks like, for costing the warning concretely. */
export interface LeverageContext {
  side: 'buy' | 'sell'
  /** Order price (limit price, or the mark for a market order). */
  price: number
  qty: number
  usdInrRate: number
}

/**
 * Rows for the danger-zone warning.
 *
 * Deliberately concrete. "High leverage is risky" teaches nothing; the price
 * this specific position gets liquidated at, and the percentage move that does
 * it, is something a trader can weigh. Falls back to the leverage-only rows
 * when the order is not yet valid enough to cost.
 */
export function leverageWarningLines(level: LeverageLevel, ctx?: LeverageContext): ConfirmLine[] {
  const lines: ConfirmLine[] = [
    { k: 'Leverage', v: `${level}x`, tone: 'destructive' },
    { k: 'Wiped out by', v: `a ${wipeoutMovePct(level).toFixed(1)}% move against you`, tone: 'destructive' },
  ]
  const usable = ctx && Number.isFinite(ctx.price) && ctx.price > 0 && Number.isFinite(ctx.qty) && ctx.qty > 0
  if (!usable) return lines

  const signedQty = ctx.side === 'buy' ? ctx.qty : -ctx.qty
  const liq = liquidationPrice({ qty: signedQty, avgPrice: ctx.price, leverage: level })
  const notionalInr = ctx.qty * ctx.price * ctx.usdInrRate
  lines.push(
    { k: 'Est. Liquidation', v: liq === null ? '—' : usd(liq), tone: 'destructive' },
    { k: 'Margin posted', v: inr(notionalInr / level) },
    { k: 'Position size', v: inr(notionalInr) },
  )
  return lines
}

/** The prose beneath the rows. */
export function leverageWarningText(level: LeverageLevel): string {
  return (
    `At ${level}x you are controlling ${level} times your margin. The liquidation price sits ` +
    `just ${wipeoutMovePct(level).toFixed(1)}% away, so a single adverse move can wipe out the ` +
    `entire position — not just the profit on it. This is above the ${MAX_UNGATED_LEVERAGE}x ` +
    `normal range.`
  )
}
