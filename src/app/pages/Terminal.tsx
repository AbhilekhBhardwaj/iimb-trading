import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
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
import { applyLeveredFill, liquidationPrice, requiredMargin } from '@iimb-trading/engine'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, INPUT, LIST_ROW, MOTION } from '../../lib/design-patterns'
import { supabase } from '../../lib/supabase'
import { NotificationStrip } from '../components/NotificationStrip'
import {
  api,
  type Bootstrap,
  type InstrumentRow,
  type Notification,
  type OrderType,
  type Side,
  type Snapshot,
} from '../../lib/api'
import { analytics } from '../../lib/analytics'

const UP = '#22c55e'
const DOWN = '#d4183d'
const TIMEFRAMES = [
  { k: '1min', s: 60 },
  { k: '2min', s: 120 },
  { k: '5min', s: 300 },
  { k: '10min', s: 600 },
] as const
type TF = (typeof TIMEFRAMES)[number]['k']
/** Candles to span in the fetch window (interval × this). Keeps a real series in view. */
const CANDLE_SPAN = 90
const intervalOf = (tf: TF) => TIMEFRAMES.find((t) => t.k === tf)!.s

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr = (v: number) => inrFmt.format(v)
const usd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const clockHMS = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })
function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Shared shell bits
// ---------------------------------------------------------------------------
function Panel({ title, right, children, className = '', delay = 0, fit = false }: {
  title?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  delay?: number
  /**
   * When true the panel is sized to its CONTENT and carries NO overflow property
   * — it can never clip or scroll. (The default CARD sets `h-full overflow-hidden`
   * to fill a fixed grid cell; a `fit` panel must live in an `auto` grid row.)
   */
  fit?: boolean
}) {
  const shell = fit
    ? 'group relative flex flex-col rounded-2xl border border-white/[0.08] bg-white/[0.03] transition-all duration-300 hover:border-amber-500/25 hover:bg-white/[0.05]'
    : `${CARD} min-h-0`
  return (
    <motion.section
      initial={MOTION.card.initial}
      animate={MOTION.card.animate}
      transition={{ duration: 0.45, delay, ease: EASE }}
      className={`${shell} ${className}`}
      style={{ boxShadow: CARD_SHADOW }}
    >
      {title && (
        <header className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2">
          <h2 className="text-[11px] uppercase tracking-[0.18em] text-subtle">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </motion.section>
  )
}

function PulseDot({ color }: { color: string }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ background: color }} />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Top — round status bar
// ---------------------------------------------------------------------------
function RoundBar({ snap, username, role, onSignOut }: {
  snap: Snapshot | null
  username: string
  role: string
  onSignOut: () => void
}) {
  const r = snap?.round
  const active = !!r?.active
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-5 py-2.5">
      <div className="flex items-baseline gap-3">
        <span className="text-lg text-bright" style={EDITORIAL_SERIF}>MochaTrade</span>
        <span className="text-[11px] text-subtle">IIM Bangalore Trading Competition</span>
      </div>
      <div className="flex items-center gap-5 font-mono text-[11px]">
        {active ? (
          <>
            <span className="flex items-center gap-1.5 text-up"><PulseDot color={UP} />ROUND {(r!.index ?? 0) + 1}</span>
            <span className="text-muted uppercase">{r!.mode?.replace(/_/g, ' ')}</span>
            <span className={r!.commissionEnabled ? 'text-[#E8C46A]' : 'text-subtle'}>
              COMMISSION {r!.commissionEnabled ? 'ON' : 'OFF'}
            </span>
            <span className="tabular-nums text-bright">{mmss(r!.remainingSeconds ?? 0)}</span>
          </>
        ) : (
          <span className="flex items-center gap-1.5 text-subtle"><PulseDot color="#71717a" />NO ACTIVE ROUND</span>
        )}
        <span className="text-subtle">·</span>
        <Link to="/portfolio" className="text-muted transition-colors hover:text-[#E8C46A]">Portfolio</Link>
        <span className="text-subtle">·</span>
        <Link to="/news" className="text-muted transition-colors hover:text-[#E8C46A]">News</Link>
        <span className="text-subtle">·</span>
        <span className="text-muted">{username} <span className="text-subtle">({role.replace('_', ' ')})</span></span>
        <button onClick={onSignOut} className="text-subtle transition-colors hover:text-destructive">sign out</button>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Bottom — persistent notification strip
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Left 1 — instrument list
// ---------------------------------------------------------------------------
function InstrumentList({ rows, selected, onSelect }: {
  rows: InstrumentRow[]
  selected: string
  onSelect: (t: string) => void
}) {
  return (
    <Panel title="Instruments" right={<span className="font-mono text-[10px] text-subtle">{rows.length}</span>} delay={0}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-1 flex items-center gap-2 px-3 text-[9px] uppercase tracking-wider text-subtle">
          <span className="flex-1">Ticker</span>
          <span className="w-16 text-right">LTP</span>
          <span className="w-14 text-right">Qty</span>
          <span className="w-16 text-right">Avg</span>
        </div>
        {rows.map((s) => {
          const sel = s.ticker === selected
          const pos = s.position
          return (
            <button
              key={s.ticker}
              onClick={() => onSelect(s.ticker)}
              className={`${LIST_ROW} relative mb-0.5 w-full text-left`}
              style={{ gap: 8, paddingLeft: 14, paddingRight: 12, paddingTop: 5, paddingBottom: 5,
                ...(sel ? { borderColor: 'rgba(232,196,106,0.45)', background: 'rgba(255,255,255,0.055)' } : null) }}
            >
              {sel && <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full" style={{ background: GOLD.solid }} />}
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[13px] font-semibold text-bright">{s.ticker}</span>
                <span className="block truncate text-[10px] text-subtle">{s.name}</span>
              </span>
              <span className="w-16 text-right font-mono text-[12px] tabular-nums text-foreground">{usd(s.ltp)}</span>
              <span className={`w-14 text-right font-mono text-[12px] tabular-nums ${pos ? (pos.qty >= 0 ? 'text-up' : 'text-destructive') : 'text-subtle'}`}>
                {pos ? pos.qty : '—'}
              </span>
              <span className="w-16 text-right font-mono text-[12px] tabular-nums text-muted">{pos ? usd(pos.avgPrice) : '—'}</span>
            </button>
          )
        })}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Left 2 — order window (+ working orders + confirm popup)
// ---------------------------------------------------------------------------
interface PendingOrder { side: Side; type: OrderType; qty: number; price: number; leverage: number; requiredInr: number; liq: number | null; closes: boolean }

// A position-reducing order frees margin (requiredMargin < 0); never show that as
// a negative "required" figure. A closing order leaves no position, hence no liq.
const marginLabel = (requiredInr: number) => (requiredInr > 1 ? inr(requiredInr) : '— (frees margin)')
const liqLabel = (closes: boolean, liq: number | null) => (closes ? 'Flat after close' : liq === null ? '—' : usd(liq))

function OrderWindow({ ticker, row, roundActive, rate, onConfirmPlace }: {
  ticker: string
  row: InstrumentRow | undefined
  roundActive: boolean
  rate: number
  onConfirmPlace: (o: PendingOrder) => void
}) {
  const [side, setSide] = useState<Side>('buy')
  const [type, setType] = useState<OrderType>('limit')
  const [qty, setQty] = useState(10)
  const [price, setPrice] = useState(0)
  const leverage = 1 // leverage selector removed from the order window; default no-leverage

  const ltp = row?.ltp ?? 0
  // Keep the limit price synced to LTP until the user edits it.
  const edited = useRef(false)
  useEffect(() => { edited.current = false }, [ticker])
  useEffect(() => { if (!edited.current) setPrice(Number(ltp.toFixed(2))) }, [ltp])

  const px = type === 'limit' ? price : ltp
  const existing = row?.position
    ? { qty: row.position.qty, avgPrice: row.position.avgPrice, leverage: row.position.leverage }
    : { qty: 0, avgPrice: 0, leverage }
  const signedQty = side === 'buy' ? qty : -qty
  const valid = qty > 0 && px > 0
  // Still computed for the confirm popup (not shown in this panel).
  const requiredInr = (valid ? requiredMargin(existing, signedQty, px, leverage) : 0) * rate
  const resulting = valid ? applyLeveredFill(existing, signedQty, px, leverage) : null
  const closes = !!resulting && existing.qty !== 0 && resulting.qty === 0
  const liq = resulting && resulting.qty !== 0 ? liquidationPrice(resulting) : null
  const priceColor = side === 'buy' ? UP : DOWN

  return (
    <Panel title="Order Window" delay={0.06} fit>
      <div className="flex flex-col gap-3 px-4 py-3">
        {/* Selected Script */}
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-[0.16em] text-subtle">Selected Script</span>
          <span className="font-mono text-sm font-semibold text-[#E8C46A]">{ticker || '—'}</span>
        </div>

        {/* Buy / Sell */}
        <div className="grid grid-cols-2 gap-2">
          {(['buy', 'sell'] as const).map((s) => {
            const on = side === s
            const cls = s === 'buy' ? 'border-up/50 bg-up/10 text-up' : 'border-destructive/50 bg-destructive/10 text-destructive'
            return (
              <button key={s} onClick={() => setSide(s)}
                className={`rounded-lg border py-2 text-sm font-medium uppercase transition-colors ${on ? cls : 'border-white/10 bg-white/[0.02] text-muted hover:bg-white/[0.04]'}`}>
                {s}
              </button>
            )
          })}
        </div>

        {/* Qty + Price side by side; Limit/Market stacked to their right */}
        <div className="flex gap-2">
          <label className="flex-1">
            <span className="mb-0.5 block text-[10px] uppercase tracking-[0.16em] text-subtle">Qty</span>
            <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
              className={`${INPUT} font-mono tabular-nums`} style={{ paddingTop: 6, paddingBottom: 6 }} />
          </label>
          <label className="flex-1">
            <span className="mb-0.5 block text-[10px] uppercase tracking-[0.16em] text-subtle">Price</span>
            <input type="number" step="0.01" disabled={type === 'market'}
              value={type === 'market' ? Number(ltp.toFixed(2)) : price}
              onChange={(e) => { edited.current = true; setPrice(Number(e.target.value) || 0) }}
              className={`${INPUT} font-mono tabular-nums disabled:opacity-50`} style={{ paddingTop: 6, paddingBottom: 6, color: priceColor }} />
          </label>
          <div className="flex w-16 flex-col gap-1 self-stretch pt-[18px]">
            {(['limit', 'market'] as const).map((t) => (
              <button key={t} onClick={() => setType(t)}
                className={`flex-1 rounded-md border text-[10px] uppercase tracking-wide transition-colors ${type === t ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/10 text-muted hover:bg-white/[0.04]'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Minimal submit */}
        <button
          disabled={!roundActive || !valid}
          onClick={() => onConfirmPlace({ side, type, qty, price: px, leverage, requiredInr, liq, closes })}
          className={`mt-1 rounded-lg border py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            side === 'buy' ? 'border-up/40 bg-up/10 text-up hover:bg-up/20' : 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
          }`}>
          {roundActive ? `Place ${side.toUpperCase()} Order` : 'Waiting for round…'}
        </button>
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Left 3 — screener (placeholder fundamentals)
// ---------------------------------------------------------------------------
function Screener({ row }: { row: InstrumentRow | undefined }) {
  const metrics = [
    { k: 'Market Cap', v: '—' },
    { k: 'P/E (TTM)', v: '—' },
    { k: 'EPS', v: '—' },
    { k: 'Div. Yield', v: '—' },
    { k: '52W Range', v: '—' },
    { k: 'Beta', v: '—' },
  ]
  return (
    <Panel title="Main Share Reports (Screener)" delay={0.12}>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {row ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-lg font-semibold text-bright">{row.ticker}</span>
              <span className="text-[11px] text-subtle">{row.name} · {row.sector}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-white/[0.06]">
              {metrics.map((m) => (
                <div key={m.k} className="bg-background/60 px-3 py-2">
                  <div className="text-[9px] uppercase tracking-[0.14em] text-subtle">{m.k}</div>
                  <div className="mt-0.5 font-mono text-[13px] tabular-nums text-muted">{m.v}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[10px] leading-relaxed text-amber-300/80">
              Illustrative placeholder — real fundamentals are not wired yet and these figures are not final.
            </p>
          </>
        ) : (
          <div className="py-6 text-center text-xs text-subtle">Select an instrument.</div>
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Right 1 — price chart
// ---------------------------------------------------------------------------
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

function PriceChart({ snap, ticker, ltp, tf, onTf }: {
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

// ---------------------------------------------------------------------------
// Right 2 — market depth (+ market-maker resting-order list)
// ---------------------------------------------------------------------------
const DEPTH_LEVELS = 30 // per side; the ladder scrolls within its panel to reveal depth

/** Shared 3-column grid: bid-size | central price | ask-size. */
const LADDER_COLS = 'grid grid-cols-[1fr_84px_1fr] items-center'

function DepthLadder({ snap, role }: { snap: Snapshot | null; role: string }) {
  const depth = snap?.depth
  // Zero-qty levels are already excluded upstream. Asks ascending (best/lowest
  // first); bids descending (best/highest first). Both sides nearest the spread.
  const asks = [...(depth?.asks ?? [])].sort((a, b) => a.price - b.price).slice(0, DEPTH_LEVELS)
  const bids = [...(depth?.bids ?? [])].sort((a, b) => b.price - a.price).slice(0, DEPTH_LEVELS)
  const maxQty = Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty))
  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : null
  const resting = role === 'market_maker' ? depth?.restingOrders : undefined
  const empty = asks.length === 0 && bids.length === 0

  return (
    <Panel
      title="Market Depth"
      delay={0.06}
      right={role === 'market_maker' ? <span className="text-[9px] uppercase tracking-wider text-[#E8C46A]">MM · full book</span> : undefined}
    >
      <div className="flex min-h-0 flex-1 flex-col p-2 text-[11px]">
        <div className={`${LADDER_COLS} px-2 pb-1 text-[9px] uppercase tracking-wider text-subtle`}>
          <span className="text-right">Bid Size</span>
          <span className="text-center">Price</span>
          <span className="text-left">Ask Size</span>
        </div>

        {empty ? (
          <div className="flex flex-1 items-center justify-center text-subtle">No resting orders.</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
            {/* ASKS above the spread — lowest (best) sits at the bottom, nearest the line */}
            <div className="flex flex-col gap-px">
              {[...asks].reverse().map((l) => (
                <LadderRow key={`a${l.price}`} price={l.price} qty={l.qty} maxQty={maxQty} side="ask" />
              ))}
            </div>

            {/* Spread divider line */}
            <div className="my-1.5 flex items-center gap-2 px-2">
              <div className="h-px flex-1 bg-white/[0.12]" />
              <span className="font-mono text-[10px] tabular-nums text-subtle">{spread === null ? '—' : usd(spread)}</span>
              <div className="h-px flex-1 bg-white/[0.12]" />
            </div>

            {/* BIDS below the spread — highest (best) sits at the top, nearest the line */}
            <div className="flex flex-col gap-px">
              {bids.map((l) => (
                <LadderRow key={`b${l.price}`} price={l.price} qty={l.qty} maxQty={maxQty} side="bid" />
              ))}
            </div>
          </div>
        )}

        {resting && resting.length > 0 && (
          <div className="mt-2 border-t border-white/[0.06] pt-2">
            <div className="mb-1 text-[9px] uppercase tracking-[0.16em] text-subtle">Resting Orders ({resting.length})</div>
            <div className="flex max-h-20 flex-col gap-0.5 overflow-y-auto">
              {resting.map((o) => (
                <div key={o.orderId} className="flex items-center gap-2 font-mono tabular-nums">
                  <span className={`w-9 ${o.side === 'buy' ? 'text-up' : 'text-destructive'}`}>{o.side === 'buy' ? 'BUY' : 'SELL'}</span>
                  <span className="w-16 text-right text-foreground">{usd(o.price)}</span>
                  <span className="w-12 text-right text-muted">{o.remainingQty}</span>
                  <span className="w-8 text-right text-subtle">{o.leverage}x</span>
                  <span className="flex-1 truncate text-right text-[9px] text-subtle">{o.accountId.slice(0, 8)}…</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}

/**
 * One ladder level. Price is the central spine; quantity sits to the RIGHT of
 * the price for asks and to the LEFT for bids, with a subtle depth bar growing
 * outward from the centre (reddish for asks, greenish for bids).
 */
function LadderRow({ price, qty, maxQty, side }: { price: number; qty: number; maxQty: number; side: 'ask' | 'bid' }) {
  const color = side === 'ask' ? DOWN : UP
  const barBg = side === 'ask' ? 'rgba(212,24,61,0.12)' : 'rgba(34,197,94,0.12)'
  const barWidth = `${(qty / maxQty) * 50}%`
  return (
    <div className={`${LADDER_COLS} relative rounded py-[3px] font-mono text-[11px] tabular-nums`}>
      <span
        className="absolute inset-y-0 rounded-sm"
        style={side === 'ask' ? { left: '50%', width: barWidth, background: barBg } : { right: '50%', width: barWidth, background: barBg }}
      />
      {side === 'ask' ? (
        <>
          <span />
          <span className="relative text-center font-semibold" style={{ color }}>{usd(price)}</span>
          <span className="relative pl-3 text-left text-foreground">{qty}</span>
        </>
      ) : (
        <>
          <span className="relative pr-3 text-right text-foreground">{qty}</span>
          <span className="relative text-center font-semibold" style={{ color }}>{usd(price)}</span>
          <span />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Right 3 — Times & Sales
// ---------------------------------------------------------------------------
function TimesAndSales({ snap, ticker }: { snap: Snapshot | null; ticker: string }) {
  const trades = snap?.trades ?? [] // newest first
  return (
    <Panel title="Times & Sales" delay={0.12} right={<span className="font-mono text-[10px] text-subtle">{trades.length}</span>}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-[11px]">
        <div className="mb-1 flex items-center gap-2 px-2 text-[9px] uppercase tracking-wider text-subtle">
          <span className="w-20">Time</span><span className="w-14">Script</span>
          <span className="flex-1 text-right">P&L (Δ)</span><span className="w-12 text-right">Qty</span><span className="w-12 text-right">Side</span>
        </div>
        {trades.length === 0 ? (
          <div className="py-4 text-center text-subtle">No prints yet.</div>
        ) : (
          trades.map((t, i) => {
            const prev = trades[i + 1] // next older
            const delta = prev ? t.price - prev.price : 0
            return (
              <div key={t.id} className="flex items-center gap-2 px-2 py-0.5 font-mono tabular-nums">
                <span className="w-20 text-subtle">{clockHMS(t.t)}</span>
                <span className="w-14 text-foreground">{ticker}</span>
                <span className={`flex-1 text-right ${delta > 0 ? 'text-up' : delta < 0 ? 'text-destructive' : 'text-subtle'}`}>
                  {delta === 0 ? usd(t.price) : `${delta > 0 ? '+' : '−'}${usd(Math.abs(delta))}`}
                </span>
                <span className="w-12 text-right text-muted">{t.qty}</span>
                <span className={`w-12 text-right font-semibold ${t.side === 'buy' ? 'text-up' : t.side === 'sell' ? 'text-destructive' : 'text-subtle'}`}>
                  {t.side ? t.side.toUpperCase() : '—'}
                </span>
              </div>
            )
          })
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------
function Overlay({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}
        className={`${CARD} w-full max-w-sm p-6`} style={{ boxShadow: CARD_SHADOW }} onClick={(e) => e.stopPropagation()}>
        {children}
      </motion.div>
    </div>
  )
}

function ConfirmDialog({ title, lines, confirmLabel, tone, onConfirm, onCancel }: {
  title: string
  lines: { k: string; v: string; tone?: 'up' | 'destructive' }[]
  confirmLabel: string
  tone: 'up' | 'destructive'
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Overlay onClose={onCancel}>
      <h3 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.35rem' }}>{title}</h3>
      <dl className="mt-4 flex flex-col gap-1.5 text-[13px]">
        {lines.map((l) => (
          <div key={l.k} className="flex items-center justify-between">
            <dt className="text-subtle">{l.k}</dt>
            <dd className={`font-mono tabular-nums ${l.tone === 'up' ? 'text-up' : l.tone === 'destructive' ? 'text-destructive' : 'text-foreground'}`}>{l.v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-full border border-white/10 py-2.5 text-sm text-muted transition-colors hover:bg-white/[0.04]">Cancel</button>
        <button onClick={onConfirm}
          className={`flex-1 rounded-full py-2.5 text-sm font-medium text-bright transition-colors ${tone === 'up' ? 'bg-up/20 hover:bg-up/30' : 'bg-destructive/20 hover:bg-destructive/30'}`}>
          {confirmLabel}
        </button>
      </div>
    </Overlay>
  )
}

interface Toast { id: number; ok: boolean; title: string; detail?: string }
function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-20 right-5 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <motion.div key={t.id} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
          className={`${CARD} min-w-[240px] max-w-xs p-3`}
          style={{ boxShadow: CARD_SHADOW, borderColor: t.ok ? 'rgba(34,197,94,0.35)' : 'rgba(212,24,61,0.35)' }}>
          <div className={`text-[12px] font-semibold ${t.ok ? 'text-up' : 'text-destructive'}`}>{t.title}</div>
          {t.detail && <div className="mt-0.5 text-[11px] text-muted">{t.detail}</div>}
        </motion.div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function Terminal() {
  const navigate = useNavigate()
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [selected, setSelected] = useState('')
  const [tf, setTf] = useState<TF>('5min')
  const [pending, setPending] = useState<PendingOrder | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [announcement, setAnnouncement] = useState<Notification | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seenAnn = useRef<Set<string> | null>(null)
  const toastSeq = useRef(0)

  const windowSec = intervalOf(tf) * CANDLE_SPAN // fetch enough history for a full candle series

  const pushToast = useCallback((ok: boolean, title: string, detail?: string) => {
    const id = ++toastSeq.current
    setToasts((prev) => [...prev, { id, ok, title, detail }])
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500)
  }, [])

  // Auth + bootstrap.
  useEffect(() => {
    analytics.pageview('/terminal')
    let alive = true
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) { navigate('/login', { replace: true }); return }
      try {
        const b = await api.bootstrap()
        if (!alive) return
        setBoot(b)
        setSelected(b.instruments[0]?.ticker ?? '')
      } catch {
        // Authenticated but the engine API is unreachable — show a clear message
        // rather than bouncing back to /login (which looks like a failed login).
        if (alive) setError('Could not reach the trading server. Make sure the API is running (npm run api), then retry.')
      }
    })()
    return () => { alive = false }
  }, [navigate])

  // Poll the snapshot for the selected instrument + timeframe window.
  useEffect(() => {
    if (!boot || !selected) return
    let alive = true
    const tick = async () => {
      try {
        const s = await api.snapshot(selected, windowSec)
        if (alive) setSnap(s)
      } catch { /* transient — next tick retries */ }
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => { alive = false; window.clearInterval(id) }
  }, [boot, selected, windowSec])

  // Announcement popups: seed seen-set on first load, pop only genuinely new ones.
  useEffect(() => {
    if (!snap) return
    const anns = snap.notifications.filter((n) => n.kind === 'announcement')
    if (seenAnn.current === null) { seenAnn.current = new Set(anns.map((a) => a.id)); return }
    const fresh = anns.find((a) => !seenAnn.current!.has(a.id))
    if (fresh) { seenAnn.current.add(fresh.id); setAnnouncement(fresh) }
  }, [snap])

  const rows = snap?.instruments ?? []
  const row = rows.find((r) => r.ticker === selected)
  const roundActive = !!snap?.round.active

  async function doPlace(o: PendingOrder) {
    setPending(null)
    analytics.capture('order_placed', { ticker: selected, side: o.side, type: o.type, qty: o.qty, leverage: o.leverage })
    try {
      const res = await api.placeOrder({ ticker: selected, side: o.side, type: o.type, price: o.type === 'limit' ? o.price : undefined, qty: o.qty, leverage: o.leverage })
      if (!res.accepted) {
        analytics.capture('order_rejected', { ticker: selected, side: o.side, type: o.type, qty: o.qty, reason: res.reason })
        pushToast(false, 'Order rejected', res.reason); return
      }
      const filled = (res.trades ?? []).reduce((a, t) => a + t.qty, 0)
      if (filled > 0) analytics.capture('order_filled', { ticker: selected, side: o.side, type: o.type, qty: o.qty, filledQty: filled })
      if (filled === 0) pushToast(true, 'Order resting', `${o.qty} @ ${usd(o.price)} on the book`)
      else if (filled < o.qty) pushToast(true, 'Partial fill', `${filled}/${o.qty} filled`)
      else pushToast(true, 'Order filled', `${filled} @ avg ${usd(o.price)}`)
    } catch { pushToast(false, 'Order failed', 'Network / server error') }
  }


  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className={`${CARD} max-w-sm p-8`} style={{ boxShadow: CARD_SHADOW }}>
          <h1 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.5rem' }}>Trading server unavailable</h1>
          <p className="mt-3 text-sm text-muted">{error}</p>
          <div className="mt-6 flex gap-2">
            <button onClick={() => window.location.reload()} className="flex-1 rounded-full py-2.5 text-sm font-medium text-bright" style={{ background: GOLD.solid, color: '#0a0a0a' }}>Retry</button>
            <button onClick={async () => { await supabase.auth.signOut(); analytics.reset(); navigate('/login', { replace: true }) }} className="flex-1 rounded-full border border-white/10 py-2.5 text-sm text-muted transition-colors hover:bg-white/[0.04]">Sign out</button>
          </div>
        </div>
      </div>
    )
  }

  if (!boot) {
    return <div className="flex h-screen items-center justify-center bg-background text-subtle">Loading terminal…</div>
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <RoundBar snap={snap} username={boot.username} role={boot.role} onSignOut={async () => { await supabase.auth.signOut(); analytics.reset(); navigate('/login', { replace: true }) }} />

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 p-4">
        {/* LEFT column: instruments / order / screener */}
        <div className="grid min-h-0 grid-rows-[minmax(0,1.45fr)_auto_minmax(0,0.8fr)] gap-4">
          <InstrumentList rows={rows} selected={selected} onSelect={setSelected} />
          <OrderWindow ticker={selected} row={row} roundActive={roundActive}
            rate={snap?.rate ?? 83} onConfirmPlace={setPending} />
          <Screener row={row} />
        </div>

        {/* RIGHT column: chart / depth / times & sales */}
        <div className="grid min-h-0 grid-rows-[minmax(0,1.45fr)_minmax(0,1.15fr)_minmax(0,0.8fr)] gap-4">
          <PriceChart snap={snap} ticker={selected} ltp={row?.ltp ?? 0} tf={tf} onTf={setTf} />
          <DepthLadder snap={snap} role={boot.role} />
          <TimesAndSales snap={snap} ticker={selected} />
        </div>
      </div>

      <NotificationStrip notifications={snap?.notifications ?? []} />

      {/* Popups */}
      {pending && (
        <ConfirmDialog
          title="Confirm Order"
          tone={pending.side === 'buy' ? 'up' : 'destructive'}
          confirmLabel={`Confirm ${pending.side.toUpperCase()}`}
          onCancel={() => setPending(null)}
          onConfirm={() => doPlace(pending)}
          lines={[
            { k: 'Instrument', v: selected },
            { k: 'Side', v: pending.side.toUpperCase(), tone: pending.side === 'buy' ? 'up' : 'destructive' },
            { k: 'Type', v: pending.type.toUpperCase() },
            { k: 'Quantity', v: String(pending.qty) },
            { k: 'Price', v: pending.type === 'market' ? 'MARKET' : usd(pending.price) },
            { k: 'Leverage', v: `${pending.leverage}x` },
            { k: 'Margin Required', v: marginLabel(pending.requiredInr) },
            { k: 'Est. Liquidation', v: liqLabel(pending.closes, pending.liq) },
          ]}
        />
      )}
      {announcement && (
        <Overlay onClose={() => setAnnouncement(null)}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E8C46A]">Announcement</div>
          <h3 className="mt-2 text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.5rem' }}>{announcement.title}</h3>
          {announcement.body && <p className="mt-2 text-sm text-muted">{announcement.body}</p>}
          <button onClick={() => setAnnouncement(null)} className="mt-6 w-full rounded-full border border-white/10 py-2.5 text-sm text-muted transition-colors hover:bg-white/[0.04]">Dismiss</button>
        </Overlay>
      )}
      <Toasts toasts={toasts} />
    </div>
  )
}

export default Terminal
