/**
 * All chart TIME handling in one place: bucketing trades into candles, deciding
 * how to push them into the series, and choosing what the axis should show.
 *
 * These three were previously spread across PriceChart.tsx, where buildCandles
 * had no test coverage at all. They are one concern — the chart's notion of
 * time — and they fail together, so they live and are tested together.
 *
 * ---------------------------------------------------------------------------
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


// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/** One executed trade, as the price-history endpoint returns it. */
export interface PricePoint {
  /** Epoch MILLISECONDS. */
  t: number
  price: number
  qty: number
}

/** An OHLC candle. `time` is epoch SECONDS, as lightweight-charts expects. */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface Volume {
  time: number
  value: number
}

/**
 * Aggregate trades into OHLC candles of exactly `intervalSec`.
 *
 * Each trade's timestamp is FLOORED to the interval, so a 5-minute chart yields
 * buckets at :00, :05, :10 and so on, regardless of when trades actually
 * landed. Open is the first trade in the bucket, close the last, high and low
 * the extremes; volume sums.
 *
 * Input is assumed ascending by time (the server orders it that way), which is
 * what makes "last write wins" the correct rule for close. Buckets are sorted
 * on the way out regardless, so the series is always monotonically increasing
 * even if a caller hands over unordered points.
 */
export function buildCandles(
  points: readonly PricePoint[],
  intervalSec: number,
): { candles: Candle[]; volumes: Volume[] } {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return { candles: [], volumes: [] }

  const byBucket = new Map<number, { o: number; h: number; l: number; c: number; v: number }>()
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.price)) continue
    const bucket = Math.floor(p.t / 1000 / intervalSec) * intervalSec
    const b = byBucket.get(bucket)
    const qty = Number.isFinite(p.qty) ? p.qty : 0
    if (!b) byBucket.set(bucket, { o: p.price, h: p.price, l: p.price, c: p.price, v: qty })
    else {
      b.h = Math.max(b.h, p.price)
      b.l = Math.min(b.l, p.price)
      b.c = p.price
      b.v += qty
    }
  }

  const times = [...byBucket.keys()].sort((a, b) => a - b)
  return {
    candles: times.map((t) => {
      const b = byBucket.get(t)!
      return { time: t, open: b.o, high: b.h, low: b.l, close: b.c }
    }),
    volumes: times.map((t) => ({ time: t, value: byBucket.get(t)!.v })),
  }
}

// ---------------------------------------------------------------------------
// What the axis should show
// ---------------------------------------------------------------------------

export interface VisibleRange {
  from: number
  to: number
}

/**
 * The logical bar range to display, anchored on the MOST RECENT candle.
 *
 * The old rule re-fitted only when the series was replaced or grew, so once a
 * book went quiet the view stayed wherever it had last been left — showing a
 * stale slice while newer data sat off-screen. Anchoring on the newest candle
 * means the latest bar is always in view.
 *
 * With fewer candles than the canvas can hold, they are centred with equal
 * padding rather than pinned to the right of an empty chart. Once there are
 * enough to fill it, the most recent `capacity` bars are shown and older ones
 * scroll off to the left, which is what a live chart should do.
 */
export function visibleRange(candleCount: number, capacity: number): VisibleRange | null {
  if (candleCount <= 0) return null
  const slots = Math.max(1, Math.floor(capacity))
  if (candleCount >= slots) {
    // Show the newest `slots` bars, with the last one flush at the right edge.
    return { from: candleCount - slots, to: candleCount - 1 }
  }
  const pad = (slots - candleCount) / 2
  return { from: -pad, to: candleCount - 1 + pad }
}

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
