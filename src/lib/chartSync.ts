/**
 * Deciding how to push new candles into the chart series.
 *
 * lightweight-charts throws "Cannot update oldest data" if `update()` is handed
 * a time earlier than the series' last one. The chart used to choose between
 * `update()` and `setData()` on CANDLE COUNT alone — same length, or one more,
 * meant "incremental". Count is not a proxy for time order, and two independent
 * things broke that assumption:
 *
 *   1. Clicking a new instrument updates `ticker` immediately while `snap` still
 *      holds the PREVIOUS instrument's prices. For one render the chart draws
 *      another instrument's candles under the new ticker's identity — a visible
 *      flash of wrong data, and it leaves the series' last time set from that
 *      instrument.
 *   2. When the real snapshot arrives the shape is unchanged, so if the new
 *      instrument happens to have the same candle count (or one more), the code
 *      took the `update()` path — with a time that can be EARLIER than the one
 *      already pushed. That is the crash.
 *
 * Both are fixed here rather than in the effect: skip a snapshot that belongs to
 * another instrument, and never update backwards whatever the counts say.
 */

export type ChartAction =
  /** The snapshot is for a different instrument; render nothing yet. */
  | 'skip'
  /** Replace the whole series. Always safe: it resets the last-time guard. */
  | 'setData'
  /** Amend the newest bar only, so an intra-bucket poll does not refit the view. */
  | 'update'

export interface ChartSyncInput {
  /** Ticker the snapshot was fetched FOR. Null when the payload omits it. */
  snapTicker: string | null
  /** Ticker the chart is currently meant to show. */
  ticker: string
  /** `${ticker}|${intervalSec}` for the incoming data. */
  shape: string
  /** The shape last rendered. */
  prevShape: string
  candleCount: number
  prevCount: number
  /** Newest candle time in the incoming data (epoch seconds), or null if empty. */
  newestTime: number | null
  /** Newest time actually pushed into the series, or null if nothing has been. */
  lastPushedTime: number | null
}

export function chartAction(i: ChartSyncInput): ChartAction {
  // A snapshot for another instrument is not this chart's data. Waiting one poll
  // is strictly better than drawing the wrong series and poisoning the guard.
  if (i.snapTicker !== null && i.snapTicker !== i.ticker) return 'skip'

  // Nothing to draw: setData([]) clears cleanly; update() has no bar to amend.
  if (i.candleCount === 0) return 'setData'

  // A different instrument or timeframe is a full redraw by definition.
  if (i.shape !== i.prevShape) return 'setData'

  // THE GUARD. Going backwards is exactly what lightweight-charts refuses, and
  // setData handles it without complaint.
  if (i.newestTime !== null && i.lastPushedTime !== null && i.newestTime < i.lastPushedTime) {
    return 'setData'
  }

  // Steady state: same bucket amended, or exactly one new bucket appeared.
  const sameLen = i.candleCount === i.prevCount
  const grewByOne = i.candleCount === i.prevCount + 1
  return sameLen || grewByOne ? 'update' : 'setData'
}
