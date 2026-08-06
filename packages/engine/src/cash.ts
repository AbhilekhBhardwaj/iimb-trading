/**
 * INR cash settlement for levered positions — the model that replaces
 * continuous mark-to-market for what TEAMS see and spend.
 *
 * Pure and deterministic like margin.ts: no clock, no RNG, no I/O. The one
 * deliberate difference from the rest of the engine is that this module is
 * bi-currency, because that is its whole purpose: instrument prices are USD,
 * cash and basis are INR, and the USD→INR rate is captured at each fill.
 *
 * Model
 * -----
 * A position has TWO distinct INR quantities, and keeping them apart is the
 * thing this module exists to get right:
 *
 *   notionalBasisInr — the FULL INR notional at entry (qty · price · rate),
 *                      undivided by leverage. P&L is measured against this, so
 *                      a 5× position earns 5× the return on cash committed.
 *   posted margin    — notionalBasisInr / leverage. This is the cash actually
 *                      locked, and it is what a buy debits.
 *
 * Margin is derivable (see `postedMarginInr`), so only the notional basis is
 * stored.
 *
 *   - OPENING or ADDING debits posted margin: |qty · price · rate| / leverage.
 *     Always a debit, in BOTH directions — opening a short posts margin exactly
 *     like a long and never credits spendable cash.
 *   - HOLDING does nothing. There is no mark-price parameter in this module's
 *     signature, which is the structural guarantee that a held position cannot
 *     be revalued for settlement purposes. (Risk/liquidation still marks
 *     internally — that lives in margin.ts and is intentionally separate.)
 *   - REDUCING or CLOSING releases the margin attributable to the closed units
 *     AND realizes P&L on their full notional, valued at the rate prevailing at
 *     THAT fill (which may differ from the entry rate). Cash moves by
 *     marginReleased + realizedPnl.
 *   - A partial reduce releases basis and margin pro rata; the remaining units
 *     keep the original per-unit basis and entry rate.
 *
 * Invariant worth holding onto: over a complete round trip, net cash movement
 * equals realized P&L. Margin posted on the way in comes back on the way out.
 *
 * Sign conventions, consistent with margin.ts:
 *   - `qty` > 0 long, < 0 short, 0 flat. `delta` > 0 bought, < 0 sold.
 *   - `notionalBasisInr` is signed like `qty`, so `notionalBasisInr / qty` is
 *     the positive per-unit INR basis for longs AND shorts.
 *   - `cashFlowInr` is signed from the account's perspective: negative debits,
 *     positive credits.
 */

/** A position settled in INR cash, carrying isolated leverage. */
export interface CashPosition {
  /** Signed quantity: > 0 long, < 0 short, 0 flat. */
  qty: number
  /** Average entry price in USD. Feeds liquidation math and display. */
  avgPrice: number
  /**
   * FULL INR notional committed at entry (NOT divided by leverage), signed like
   * `qty`. Fixed at fill time; never revalued while held.
   */
  notionalBasisInr: number
  /** Isolated leverage for this position. */
  leverage: number
}

/** Result of applying a fill under INR cash settlement. */
export interface CashFillOutcome extends CashPosition {
  /** Signed INR cash movement: negative = debit, positive = credit. */
  cashFlowInr: number
  /** INR P&L locked in by the closing portion; 0 for pure opens/adds. */
  realizedPnlInr: number
  /** Units of the pre-existing position closed by this fill; 0 for opens/adds. */
  closedQty: number
  /** Margin this fill locked up (opens/adds/flip residual). Always >= 0. */
  marginPostedInr: number
  /** Margin this fill returned (reduces/closes). Always >= 0. */
  marginReleasedInr: number
}

/** A flat position — the starting point for any instrument. */
export const FLAT_CASH: CashPosition = { qty: 0, avgPrice: 0, notionalBasisInr: 0, leverage: 1 }

/** Cash currently locked as margin by a position. Flat → 0. */
export function postedMarginInr(pos: CashPosition): number {
  if (pos.qty === 0 || pos.leverage <= 0) return 0
  return Math.abs(pos.notionalBasisInr) / pos.leverage
}

/**
 * The effective blended USD→INR rate implied by a position's basis — what the
 * Portfolio page shows as "entry rate". Correct for longs, shorts, and
 * positions built across several fills at different rates. Flat → null.
 */
export function effectiveEntryRate(pos: CashPosition): number | null {
  if (pos.qty === 0 || pos.avgPrice === 0) return null
  return pos.notionalBasisInr / (pos.qty * pos.avgPrice)
}

/**
 * A position's INR cost basis for display, unsigned. Deliberately NOT a market
 * valuation: under this model an open position has no live value to teams, only
 * what was committed to it.
 */
export function positionCostBasisInr(pos: CashPosition): number {
  return Math.abs(pos.notionalBasisInr)
}

/**
 * Apply a signed fill to a position under INR cash settlement.
 *
 * `delta` > 0 bought `delta` units, < 0 sold `-delta`. `price` is the fill price
 * in USD. `usdInrRate` is the rate AT THIS FILL — baked into basis on opens/adds
 * and used to value the exit on reduces/closes. `fillLeverage` applies when the
 * fill opens or flips; adds and reduces keep the position's existing leverage.
 *
 * There is no mark-price parameter: a held position is never revalued here.
 */
export function applyCashFill(
  current: CashPosition,
  delta: number,
  price: number,
  usdInrRate: number,
  fillLeverage: number,
): CashFillOutcome {
  const { qty, avgPrice, notionalBasisInr, leverage } = current
  if (delta === 0) {
    return {
      ...current,
      cashFlowInr: 0,
      realizedPnlInr: 0,
      closedQty: 0,
      marginPostedInr: 0,
      marginReleasedInr: 0,
    }
  }

  const fillNotionalInr = delta * price * usdInrRate // signed like delta
  const newQty = qty + delta

  // --- Open from flat -------------------------------------------------------
  // Posts margin in either direction. A short open debits margin; it never
  // credits the proceeds, so it cannot fund further buying power.
  if (qty === 0) {
    const marginPostedInr = Math.abs(fillNotionalInr) / fillLeverage
    return {
      qty: newQty,
      avgPrice: price,
      notionalBasisInr: fillNotionalInr,
      leverage: fillLeverage,
      cashFlowInr: -marginPostedInr,
      realizedPnlInr: 0,
      closedQty: 0,
      marginPostedInr,
      marginReleasedInr: 0,
    }
  }

  // --- Add in the same direction -------------------------------------------
  // Accumulates basis at this fill's rate and posts additional margin at the
  // position's existing leverage. Nothing is realized.
  if (Math.sign(qty) === Math.sign(delta)) {
    const marginPostedInr = Math.abs(fillNotionalInr) / leverage
    return {
      qty: newQty,
      avgPrice: (qty * avgPrice + delta * price) / newQty,
      notionalBasisInr: notionalBasisInr + fillNotionalInr,
      leverage,
      cashFlowInr: -marginPostedInr,
      realizedPnlInr: 0,
      closedQty: 0,
      marginPostedInr,
      marginReleasedInr: 0,
    }
  }

  // --- Opposite direction: reduce / close / flip ---------------------------
  // Per-unit basis is positive in both directions (signed basis ÷ signed qty).
  // P&L compares each closed unit's INR value NOW against its INR cost THEN, so
  // a pure FX move realizes P&L even at an unchanged USD price. P&L is on the
  // full notional, undivided by leverage — that is what leverage buys.
  const closedQty = Math.min(Math.abs(delta), Math.abs(qty))
  const perUnitBasisInr = notionalBasisInr / qty
  const exitPerUnitInr = price * usdInrRate
  const realizedPnlInr = (exitPerUnitInr - perUnitBasisInr) * closedQty * Math.sign(qty)
  const marginReleasedInr = (perUnitBasisInr * closedQty) / leverage

  // Closed flat.
  if (newQty === 0) {
    return {
      qty: 0,
      avgPrice: 0,
      notionalBasisInr: 0,
      leverage,
      cashFlowInr: marginReleasedInr + realizedPnlInr,
      realizedPnlInr,
      closedQty,
      marginPostedInr: 0,
      marginReleasedInr,
    }
  }

  // Partial reduce: entry price, per-unit basis and leverage all untouched;
  // total basis and posted margin shrink pro rata with the remaining quantity.
  if (Math.sign(newQty) === Math.sign(qty)) {
    return {
      qty: newQty,
      avgPrice,
      notionalBasisInr: perUnitBasisInr * newQty,
      leverage,
      cashFlowInr: marginReleasedInr + realizedPnlInr,
      realizedPnlInr,
      closedQty,
      marginPostedInr: 0,
      marginReleasedInr,
    }
  }

  // Flipped past zero: the old side is fully realized above, and the residual is
  // a new position opened at this fill's price/rate/leverage — so it posts fresh
  // margin, which nets against the margin just released.
  const residualNotionalInr = newQty * price * usdInrRate
  const marginPostedInr = Math.abs(residualNotionalInr) / fillLeverage
  return {
    qty: newQty,
    avgPrice: price,
    notionalBasisInr: residualNotionalInr,
    leverage: fillLeverage,
    cashFlowInr: marginReleasedInr + realizedPnlInr - marginPostedInr,
    realizedPnlInr,
    closedQty,
    marginPostedInr,
    marginReleasedInr,
  }
}

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

/**
 * Commission charged on every executed fill, per side, as a fraction of trade
 * notional (qty × price) — applied only while the active round has commission
 * enabled. 0.003 = 0.30%, the middle of IIMB's 0.2–0.5% range. Change this one
 * line to set any rate (e.g. 0.002 for 0.2%, 0.005 for 0.5%).
 *
 * Lives in the engine rather than server/config.ts because both the settlement
 * path and the terminal's order-confirmation preview need it; server/config.ts
 * re-exports it so the two cannot drift apart.
 */
export const COMMISSION_RATE = 0.003

/**
 * Commission in INR for a fill.
 *
 * Charged on the FULL fill notional, matching the live settlement path — not
 * just the portion that closes a position. The two differ only when an order
 * flips through zero.
 *
 * When the round's commission toggle is off this is 0, because the toggle
 * governs whether commission is CHARGED, not merely whether it is displayed.
 */
export function commissionInrFor(
  fillQty: number,
  price: number,
  usdInrRate: number,
  commissionEnabled: boolean,
): number {
  if (!commissionEnabled) return 0
  return COMMISSION_RATE * Math.abs(fillQty) * price * usdInrRate
}

/** Gross / commission / net split for a fill that closes or reduces a position. */
export interface ClosingPnlBreakdown {
  /** Units of the pre-existing position this fill closes. */
  closedQty: number
  /** P&L on the closed units before charges, INR at this fill's rate. */
  grossPnlInr: number
  /** Commission on the fill, INR. 0 when the round has commission disabled. */
  commissionInr: number
  /** grossPnlInr − commissionInr: what actually lands in realized P&L. */
  netPnlInr: number
}

/**
 * Realized-P&L preview for an order, for the terminal's confirmation popup.
 *
 * Returns null when the fill opens or adds to a position — nothing is realized,
 * so there is no breakdown to show. Gross comes straight out of `applyCashFill`,
 * so the preview and the settlement path cannot diverge.
 *
 * `delta` is the signed order quantity (> 0 buy, < 0 sell), `price` the expected
 * fill price in USD, and `usdInrRate` the round's pinned rate. This is a preview
 * of a single complete fill: a partially-filled order realizes proportionally
 * less.
 */
export function closingPnlBreakdown(
  current: CashPosition,
  delta: number,
  price: number,
  usdInrRate: number,
  fillLeverage: number,
  commissionEnabled: boolean,
): ClosingPnlBreakdown | null {
  const outcome = applyCashFill(current, delta, price, usdInrRate, fillLeverage)
  if (outcome.closedQty === 0) return null

  const grossPnlInr = outcome.realizedPnlInr
  const commissionInr = commissionInrFor(delta, price, usdInrRate, commissionEnabled)
  return {
    closedQty: outcome.closedQty,
    grossPnlInr,
    commissionInr,
    netPnlInr: grossPnlInr - commissionInr,
  }
}
