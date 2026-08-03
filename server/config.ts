/**
 * Server-side account/market constants.
 *
 * Instrument prices are in USD; account cash (profiles.starting_cash) and margin
 * are in INR. The margin math is currency-agnostic, so the service converts USD
 * notionals to INR (and back) with this single rate.
 *
 * Keep this in sync with the UI's USD_INR (src/lib/simulation.ts). A later step
 * should make one authoritative source; for now both are 83.
 */
export const USD_INR = 83

/**
 * Maintenance-margin rate used for liquidation. 0 = a position is liquidated
 * only when its posted margin is fully wiped (matches the terminal's model).
 * Raise this to liquidate earlier with a safety buffer.
 */
export const MAINTENANCE_MARGIN_RATE = 0

/**
 * Commission charged on every executed fill, per side, as a fraction of trade
 * notional (qty × price) — applied only while the active round has commission
 * enabled. 0.003 = 0.30%, the middle of IIMB's 0.2–0.5% range. Change this one
 * line to set any rate (e.g. 0.002 for 0.2%, 0.005 for 0.5%).
 */
export const COMMISSION_RATE = 0.003
