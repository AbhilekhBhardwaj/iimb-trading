/**
 * Margin, buying-power, and liquidation math.
 *
 * Pure and deterministic, like the order book: no clock, no RNG, no I/O, no
 * currency assumptions. Every function takes plain numbers in ONE consistent
 * unit (the caller decides USD vs INR vs anything) and returns numbers in that
 * same unit. Margin has zero room to be subtly wrong, so it lives here beside
 * the order book and is tested in isolation.
 *
 * Model: ISOLATED margin per (account, instrument) position.
 *   - qty > 0 long, qty < 0 short, qty === 0 flat.
 *   - avgPrice is the (non-negative) average entry price of the open position.
 *   - Posted margin for a position = |qty| * avgPrice / leverage.
 *   - A position is liquidated when adverse movement erodes that posted margin
 *     (optionally down to a maintenance buffer), independent of other positions.
 */

/** A position with its isolated leverage. */
export interface LeveredPosition {
  qty: number
  avgPrice: number
  leverage: number
}

/** Result of applying a fill: the new position plus any P&L it realized. */
export interface FillOutcome {
  qty: number
  avgPrice: number
  leverage: number
  /** P&L locked in by the closing/flipping portion of this fill (price units). */
  realizedPnl: number
}

/** Posted (isolated) margin for a position. Flat → 0. */
export function positionMargin(qty: number, avgPrice: number, leverage: number): number {
  if (qty === 0 || leverage <= 0) return 0
  return (Math.abs(qty) * avgPrice) / leverage
}

/**
 * Apply a signed fill to a levered position.
 *   delta > 0 bought `delta`; delta < 0 sold `-delta`. `price` is the fill price;
 *   `fillLeverage` is the order's chosen leverage, used only when the fill OPENS
 *   or FLIPS a position — adds keep the existing position's leverage, and
 *   reduces/closes don't change it.
 *
 * Cases: open (avg = price), add (quantity-weighted avg, no realized P&L),
 * reduce (avg held, realizes P&L on the closed amount), close (flat, avg 0),
 * flip (realizes P&L on the fully-closed old side; residual opens at `price`
 * with `fillLeverage`).
 */
export function applyLeveredFill(
  current: LeveredPosition,
  delta: number,
  price: number,
  fillLeverage: number,
): FillOutcome {
  const { qty, avgPrice, leverage } = current
  if (delta === 0) return { qty, avgPrice, leverage, realizedPnl: 0 }

  const newQty = qty + delta

  // Open from flat.
  if (qty === 0) return { qty: newQty, avgPrice: price, leverage: fillLeverage, realizedPnl: 0 }

  // Add in the same direction → quantity-weighted average entry, no realized P&L.
  if (Math.sign(qty) === Math.sign(delta)) {
    return { qty: newQty, avgPrice: (qty * avgPrice + delta * price) / newQty, leverage, realizedPnl: 0 }
  }

  // Opposite direction → reduce / close / flip. The overlapping amount realizes
  // P&L: for a long that's (price - avg); for a short (avg - price). Both are
  // captured by (price - avg) * sign(qty).
  const closedQty = Math.min(Math.abs(delta), Math.abs(qty))
  const realizedPnl = closedQty * (price - avgPrice) * Math.sign(qty)

  if (newQty === 0) return { qty: 0, avgPrice: 0, leverage, realizedPnl } // closed flat
  if (Math.sign(newQty) === Math.sign(qty)) return { qty: newQty, avgPrice, leverage, realizedPnl } // partial reduce
  return { qty: newQty, avgPrice: price, leverage: fillLeverage, realizedPnl } // flipped past zero
}

/**
 * Margin this order REQUIRES right now, i.e. how much posted margin the position
 * would gain if the order fully executed at `orderPrice`. Computed as
 * marginAfter − marginBefore so it is correct for opens AND adds (scales with
 * the total resulting size, not just the new lot) and is <= 0 for reduces/closes
 * (which free margin). For a flip it nets the freed margin of the closed side
 * against the newly opened side.
 *
 * `existing` is the current position (qty 0 = flat). `orderSignedQty` is the
 * order in the same signing (buy +, sell −). `orderLeverage` is the leverage
 * chosen for this order.
 */
export function requiredMargin(
  existing: LeveredPosition,
  orderSignedQty: number,
  orderPrice: number,
  orderLeverage: number,
): number {
  const before = positionMargin(existing.qty, existing.avgPrice, existing.leverage)
  const after = applyLeveredFill(existing, orderSignedQty, orderPrice, orderLeverage)
  const afterMargin = positionMargin(after.qty, after.avgPrice, after.leverage)
  return afterMargin - before
}

/**
 * The price at which an isolated position is liquidated — where an adverse move
 * has eroded the posted margin down to the maintenance buffer.
 *
 * Derivation (long): posted M = |q|·E/L; loss at price P is |q|·(E − P);
 * liquidation when M − loss = maintenance = mmr·|q|·P, giving
 * P = E·(1 − 1/L)/(1 − mmr). Shorts are symmetric: E·(1 + 1/L)/(1 + mmr).
 *
 * With the default mmr = 0 this is the exact "margin fully wiped" price
 * (e.g. 5× long liquidates at 0.8·entry, 5× short at 1.2·entry). Returns null
 * for a flat position.
 */
export function liquidationPrice(pos: LeveredPosition, maintenanceMarginRate = 0): number | null {
  if (pos.qty === 0) return null
  const { avgPrice: e, leverage: L } = pos
  return pos.qty > 0
    ? (e * (1 - 1 / L)) / (1 - maintenanceMarginRate)
    : (e * (1 + 1 / L)) / (1 + maintenanceMarginRate)
}

/**
 * Whether `markPrice` is at or beyond the position's liquidation price — i.e.
 * the position can no longer be backed by its posted margin. Flat → false.
 */
export function isLiquidatable(pos: LeveredPosition, markPrice: number, maintenanceMarginRate = 0): boolean {
  const liq = liquidationPrice(pos, maintenanceMarginRate)
  if (liq === null) return false
  return pos.qty > 0 ? markPrice <= liq : markPrice >= liq
}
