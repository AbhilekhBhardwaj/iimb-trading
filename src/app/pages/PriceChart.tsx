import { useEffect, useRef } from 'react'
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

/** Aggregate raw trade points into OHLC candles + volume bars per interval. */
function buildCandles(
  points: { t: number; price: number; qty: number }[],
  intervalSec: number,
): { candles: CandlestickData[]; volumes: HistogramData[] } {
  const byBucket = new Map<number, { o: number; h: number; l: number; c: number; v: number }>()
  for (const p of points) {
    const bucket = Math.floor(p.t / 1000 / intervalSec) * intervalSec // epoch seconds
    const b = byBucket.get(bucket)
    if (!b) byBucket.set(bucket, { o: p.price, h: p.price, l: p.price, c: p.price, v: p.qty })
    else {
      b.h = Math.max(b.h, p.price)
      b.l = Math.min(b.l, p.price)
      b.c = p.price // points arrive ascending, so the last write is the close
      b.v += p.qty
    }
  }
  const times = [...byBucket.keys()].sort((a, b) => a - b)
  const candles = times.map((t) => {
    const b = byBucket.get(t)!
    return { time: t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }
  })
  const volumes = times.map((t) => {
    const b = byBucket.get(t)!
    return { time: t as UTCTimestamp, value: b.v, color: b.c >= b.o ? VOL_UP : VOL_DOWN }
  })
  return { candles, volumes }
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
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
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
    const { candles, volumes } = buildCandles(snap?.prices ?? [], intervalSec)
    const shape = `${ticker}|${intervalSec}`

    // Full reset on a ticker/timeframe change or a non-incremental change (first
    // load, or the trailing window added/dropped more than one bucket). Otherwise
    // update just the latest bar so intra-bucket ~1s polls don't refit the view.
    const prevLen = lenRef.current
    const grewByOne = candles.length === prevLen + 1
    const sameLen = candles.length === prevLen
    const structural = shape !== shapeRef.current || !(sameLen || grewByOne)
    if (structural) {
      c.setData(candles)
      v.setData(volumes)
    } else if (candles.length > 0) {
      c.update(candles[candles.length - 1])
      v.update(volumes[volumes.length - 1])
    }
    shapeRef.current = shape
    lenRef.current = candles.length

    // Auto-fit the visible time range to the data — only on a structural change
    // or a brand-new candle (not every intra-bucket tick). With little history,
    // center the candles at a capped width so they fill a reasonable portion with
    // margin on BOTH sides (never pinned to the right of an empty canvas); once
    // there are enough candles to fill the width, fit them edge-to-edge.
    if (candles.length > 0 && (structural || grewByOne)) {
      const width = containerRef.current?.clientWidth || 600
      const barsAtMaxWidth = width / 24 // 24px = maxBarSpacing
      const ts = chart.timeScale()
      if (candles.length >= barsAtMaxWidth - 2) {
        ts.fitContent()
      } else {
        const pad = (barsAtMaxWidth - candles.length) / 2
        ts.setVisibleLogicalRange({ from: -pad, to: candles.length - 1 + pad })
      }
    }
  }, [snap?.prices, ticker, intervalSec])

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
