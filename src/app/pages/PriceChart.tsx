import { useEffect, useRef } from 'react'
import { buildCandles, chartAction, visibleRange } from '../../lib/chartSync'
import { istChartTime } from '../../lib/format'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { Panel } from '../components/Panel'
import type { Snapshot } from '../../lib/api'
import { DOWN, intervalOf, TIMEFRAMES, type TF, UP, usd } from './terminalShared'

// This whole module (and lightweight-charts, ~its own chunk) is dynamically
// imported by Terminal via React.lazy, so it only downloads when /terminal
// actually renders — it is NOT part of the initial app bundle.

const VOL_UP = 'rgba(34,197,94,0.5)'
const VOL_DOWN = 'rgba(212,24,61,0.5)'

/**
 * Candles come from lib/chartSync, which owns every time concern the chart has:
 * bucketing, the update-vs-redraw decision, and the visible range. This module
 * used to carry its own untested copy of the bucketing, which is how a
 * timeframe bug could go unnoticed. Colour is applied here because it is
 * presentation, not time.
 */
function seriesFor(points: { t: number; price: number; qty: number }[], intervalSec: number): {
  candles: CandlestickData[]
  volumes: HistogramData[]
} {
  const { candles, volumes } = buildCandles(points, intervalSec)
  return {
    candles: candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })),
    volumes: volumes.map((v, i) => ({
      time: v.time as UTCTimestamp,
      value: v.value,
      color: candles[i].close >= candles[i].open ? VOL_UP : VOL_DOWN,
    })),
  }
}

export default function PriceChart({ snap, ticker, ltp, tf, onTf }: {
  snap: Snapshot | null
  ticker: string
  ltp: number
  tf: TF
  onTf: (t: TF) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const shapeRef = useRef('') // `${ticker}|${interval}` — a change forces a full setData
  const lenRef = useRef(0)
  /** Newest time actually pushed into the series; null before the first draw. */
  const lastTimeRef = useRef<number | null>(null)

  // Create the chart once; autoSize keeps it filling the panel via ResizeObserver.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(0,0,0,0)' },
        textColor: '#71717a',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      // Fixed bar width: each candle is a constant ~8px regardless of how many
      // exist, so a single candle is a THIN candle, never a full-width block.
      // No fitContent() anywhere — that's what stretched one bar across the chart.
      // lightweight-charts has no timezone support and renders epoch times in
      // UTC, which put every candle 5:30 behind local time. The candle VALUES
      // stay true UTC epoch seconds — only the labels are translated to IST.
      localization: {
        // Crosshair readout: seconds included, since it names one exact bar.
        timeFormatter: (t: number) => istChartTime(t, true),
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        // Axis ticks: no seconds, matching secondsVisible above.
        tickMarkFormatter: (t: number) => istChartTime(t),
        barSpacing: 12,
        minBarSpacing: 2,
        maxBarSpacing: 24, // a lone candle can never stretch into a giant block
        rightOffset: 2,
      },
      crosshair: {
        vertLine: { color: 'rgba(232,196,106,0.5)', labelBackgroundColor: '#B87D30' },
        horzLine: { color: 'rgba(232,196,106,0.5)', labelBackgroundColor: '#B87D30' },
      },
    })
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN,
      borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
    })
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.4 } })
    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false, // no volume value ("30") floating on the price axis
      priceLineVisible: false,
    })
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } })

    chartRef.current = chart
    candleRef.current = candle
    volRef.current = vol
    return () => { chart.remove(); chartRef.current = candleRef.current = volRef.current = null }
  }, [])

  const intervalSec = intervalOf(tf)
  useEffect(() => {
    const chart = chartRef.current
    const c = candleRef.current
    const v = volRef.current
    if (!chart || !c || !v) return
    const { candles, volumes } = seriesFor(snap?.prices ?? [], intervalSec)
    const shape = `${ticker}|${intervalSec}`

    // Full reset on a ticker/timeframe change or a non-incremental change (first
    // load, or the trailing window added/dropped more than one bucket). Otherwise
    // update just the latest bar so intra-bucket ~1s polls don't refit the view.
    const prevLen = lenRef.current
    const newestTime = candles.length > 0 ? (candles[candles.length - 1].time as number) : null
    const action = chartAction({
      snapTicker: snap?.ticker ?? null,
      ticker,
      shape,
      prevShape: shapeRef.current,
      candleCount: candles.length,
      prevCount: prevLen,
      newestTime,
      lastPushedTime: lastTimeRef.current,
    })
    // A snapshot belonging to another instrument is not ours to draw. Leave the
    // series and every ref untouched and wait one poll.
    if (action === 'skip') return

    const structural = action === 'setData'
    if (structural) {
      c.setData(candles)
      v.setData(volumes)
    } else {
      c.update(candles[candles.length - 1])
      v.update(volumes[volumes.length - 1])
    }
    shapeRef.current = shape
    lenRef.current = candles.length
    // Track what the series has ACTUALLY been given, so the next tick can tell
    // forwards from backwards without inferring it from candle counts.
    lastTimeRef.current = newestTime

    // Keep the newest candle in view. This used to run only on a structural
    // change or a brand-new candle, so once a book went quiet the view stayed
    // wherever it had last been left — showing a stale slice while newer data
    // sat off-screen. visibleRange always anchors on the latest bar: it centres
    // a short series, and scrolls a long one so the newest bars are flush right.
    if (candles.length > 0) {
      const width = containerRef.current?.clientWidth || 600
      const range = visibleRange(candles.length, width / 24) // 24px = maxBarSpacing
      if (range) chart.timeScale().setVisibleLogicalRange(range)
    }
    // snap?.ticker is a dependency in its own right: a payload can arrive with
    // the same prices array identity but for a different instrument, and the
    // skip decision must be re-evaluated when it does.
  }, [snap?.prices, snap?.ticker, ticker, intervalSec])

  return (
    <Panel
      title={`Chart · ${ticker}`}
      delay={0}
      right={
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] tabular-nums text-bright">{usd(ltp)}</span>
          <div className="flex gap-1">
            {TIMEFRAMES.map((t) => (
              <button key={t.k} onClick={() => onTf(t.k)}
                className={`rounded-md px-2 py-0.5 font-mono text-[10px] transition-colors ${tf === t.k ? 'bg-white/[0.08] text-bright' : 'text-subtle hover:text-muted'}`}>
                {t.k}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div ref={containerRef} className="min-h-0 w-full flex-1" />
    </Panel>
  )
}
