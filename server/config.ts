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
