/**
 * Time-compression configuration.
 *
 * A live event runs for ~2 real hours, but we want players to experience
 * roughly 6 months of market movement in that window. Because GBM volatility is
 * *annualized*, the only quantity we actually have to get right is how much
 * *market time* (dt, measured in years) elapses per tick.
 *
 * Derivation:
 *   real event length    = 2 hours            = 7,200 real seconds
 *   target market length = 6 months (~0.5 yr) = 15,768,000 market seconds
 *                          (0.5 * 365 * 24 * 3600)
 *
 *   TIME_COMPRESSION_FACTOR = market seconds / real seconds
 *                           = 15,768,000 / 7,200
 *                           = 2190
 *
 * So 1 real second advances the simulated market by 2,190 seconds (~36.5 min).
 * This factor is deliberately independent of how often you tick: halving the
 * tick interval doubles the number of ticks but halves each dt, leaving the
 * total simulated time unchanged. To retune, change REAL_EVENT_DURATION_SECONDS
 * or SIMULATED_MARKET_DURATION_SECONDS and the factor (and dt) follow.
 */

export const SECONDS_PER_HOUR = 60 * 60
export const SECONDS_PER_DAY = 24 * SECONDS_PER_HOUR
/** Calendar year. Volatility is annualized against this same year length. */
export const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY

/** How long a single live event actually runs, in real seconds. */
export const REAL_EVENT_DURATION_SECONDS = 2 * SECONDS_PER_HOUR

/** How much market time that event should represent (~6 months), in market seconds. */
export const SIMULATED_MARKET_DURATION_SECONDS = 0.5 * SECONDS_PER_YEAR

/**
 * Market seconds elapsed per real second (~2190 with the defaults above).
 * This is the primary knob — raise it to pack more market time into an event.
 */
export const TIME_COMPRESSION_FACTOR =
  SIMULATED_MARKET_DURATION_SECONDS / REAL_EVENT_DURATION_SECONDS

/**
 * Default wall-clock spacing between ticks, in real seconds. Only affects
 * granularity (how many ticks you get), not the total simulated time.
 */
export const DEFAULT_TICK_INTERVAL_SECONDS = 1

/**
 * Convert a real-time interval into a GBM timestep, in *years* of market time.
 */
export function dtYears(realSeconds: number = DEFAULT_TICK_INTERVAL_SECONDS): number {
  return (realSeconds * TIME_COMPRESSION_FACTOR) / SECONDS_PER_YEAR
}

/** The default per-tick dt (in years) used by the price model. */
export const DEFAULT_DT_YEARS = dtYears()

// ---------------------------------------------------------------------------
// News-impact envelope configuration.
//
// A news item's price contribution unfolds over *real event-timeline seconds*
// (the same clock as NewsItem.fireAtSeconds), NOT compressed market time. The
// contribution at a given moment is targetDelta * impactEnvelope(secondsSinceFire),
// where the envelope is a multiple of the target delta:
//
//   [0, WINDOW)                    -> 0            reaction window: price UNCHANGED
//   [WINDOW, WINDOW+RISE)          -> 0 .. OVERSHOOT   ramp up, overshooting target
//   [WINDOW+RISE, +RETRACE)        -> OVERSHOOT .. 1   retrace back toward target
//   [WINDOW+RISE+RETRACE, inf)     -> 1            settled at target
//
// With the defaults below the phase boundaries land at 30s / 75s / 120s.
// ---------------------------------------------------------------------------

/** Reaction window: headline is visible but price does not move (seconds). */
export const NEWS_WINDOW_SECONDS = 30

/** Duration of the ramp from 0 up to the overshoot peak (seconds). */
export const NEWS_RISE_SECONDS = 45

/** Duration of the retrace from the overshoot peak back down to target (seconds). */
export const NEWS_RETRACE_SECONDS = 45

/** Peak multiple of the target delta, reached at the end of the rise phase. */
export const NEWS_OVERSHOOT = 1.3
