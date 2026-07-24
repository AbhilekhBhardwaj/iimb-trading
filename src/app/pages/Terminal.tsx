import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { motion } from 'motion/react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { NEWS_WINDOW_SECONDS, stockTargetDelta } from '@iimb-trading/engine'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, INPUT, LIST_ROW, MOTION } from '../../lib/design-patterns'
import {
  clock,
  inr,
  inrSigned,
  liquidationHealth,
  liquidationPrice,
  marginUsedUsd,
  newsAffects,
  pct,
  positionPnlUsd,
  SEED_POSITIONS,
  STARTING_CASH_INR,
  usd,
  usdAxis,
  USD_INR,
  useSimulation,
  type DisplayStock,
  type FiredNews,
  type Position,
  type Side,
} from '../../lib/simulation'

const LEVERAGES = [1, 2, 5, 10, 20] as const
const UP = '#22c55e'
const DOWN = '#d4183d'
const AMBER = '#fbbf24'
const TIMEFRAMES = [
  { k: '1m', s: 60 },
  { k: '5m', s: 300 },
  { k: 'All', s: Infinity },
] as const
type TF = (typeof TIMEFRAMES)[number]['k']

// ---------------------------------------------------------------------------
// Small shared building blocks
// ---------------------------------------------------------------------------

/** A value that briefly tints green/red (~400ms) when it moves up/down. */
function Flash({ value, children, className = '' }: { value: number; children: ReactNode; className?: string }) {
  const prev = useRef(value)
  const [dir, setDir] = useState(0)
  useEffect(() => {
    if (value > prev.current) setDir(1)
    else if (value < prev.current) setDir(-1)
    prev.current = value
    const id = window.setTimeout(() => setDir(0), 400)
    return () => window.clearTimeout(id)
  }, [value])
  const bg = dir > 0 ? 'bg-up/15' : dir < 0 ? 'bg-destructive/15' : ''
  return <span className={`rounded px-1 transition-colors duration-[400ms] ${bg} ${className}`}>{children}</span>
}

/** Pinging status dot. */
function PulseDot({ color }: { color: string }) {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70" style={{ background: color }} />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
    </span>
  )
}

/**
 * Panel layout modes:
 *   'fill' (default) — CARD's h-full; use when the panel is a grid cell.
 *   'auto'           — natural content height (shrink-0); for stacked panels.
 *   'grow'           — fills leftover space in a flex column and scrolls inside.
 * 'auto'/'grow' override CARD's hardcoded h-full via an inline height so stacked
 * panels don't each claim the full column height (which hid the news feed).
 */
function Panel({
  title,
  right,
  children,
  className = '',
  delay = 0,
  layout = 'fill',
  style: styleProp,
}: {
  title?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  delay?: number
  layout?: 'fill' | 'auto' | 'grow'
  style?: CSSProperties
}) {
  const layoutCls = layout === 'auto' ? 'shrink-0' : layout === 'grow' ? 'min-h-0 flex-1' : ''
  const style: CSSProperties = { boxShadow: CARD_SHADOW, ...styleProp }
  if (layout !== 'fill' && style.height === undefined) style.height = 'auto'
  return (
    <motion.section
      initial={MOTION.card.initial}
      animate={MOTION.card.animate}
      transition={{ duration: 0.5, delay, ease: EASE }}
      className={`${CARD} ${layoutCls} ${className}`}
      style={style}
    >
      {title && (
        <header className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
          <h2 className="text-[11px] uppercase tracking-[0.18em] text-subtle">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </motion.section>
  )
}

function PhaseBadge({ fired }: { fired: FiredNews }) {
  const remaining = Math.ceil(NEWS_WINDOW_SECONDS - fired.secondsSinceFire)
  const map = {
    reaction: { text: `REACTION · frozen ${remaining}s`, cls: 'border-amber-400/40 bg-amber-400/10 text-amber-300' },
    absorbing: { text: 'PRICING IN', cls: 'border-[#E8C46A]/40 bg-[#E8C46A]/10 text-[#E8C46A]' },
    settled: { text: 'SETTLED', cls: 'border-white/10 bg-white/[0.02] text-subtle' },
  } as const
  const m = map[fired.phase]
  return <span className={`rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-wide ${m.cls}`}>{m.text}</span>
}

function impactChips(item: FiredNews['item']) {
  const out: { label: string; v: number }[] = []
  for (const [t, v] of Object.entries(item.impact.primary)) out.push({ label: t, v })
  for (const [t, v] of Object.entries(item.impact.related)) out.push({ label: t, v })
  for (const [s, v] of Object.entries(item.impact.sector)) out.push({ label: s, v })
  if (item.impact.market) out.push({ label: 'MARKET', v: item.impact.market })
  return out
}

/** Primary ticker labels for a headline (fallback to sector / MARKET). */
function primaryLabels(item: FiredNews['item']): string[] {
  const primary = Object.keys(item.impact.primary)
  if (primary.length) return primary
  const sector = Object.keys(item.impact.sector)
  if (sector.length) return sector
  return ['MARKET']
}

// ---------------------------------------------------------------------------
// Left — instrument list
// ---------------------------------------------------------------------------

function InstrumentList({
  stocks,
  selected,
  onSelect,
}: {
  stocks: DisplayStock[]
  selected: string
  onSelect: (t: string) => void
}) {
  return (
    <Panel title="Instruments" right={<span className="font-mono text-[10px] text-subtle">{stocks.length}</span>} delay={0}>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
        {stocks.map((s) => {
          const isSel = s.ticker === selected
          const up = s.pct >= 0
          return (
            <button
              key={s.ticker}
              onClick={() => onSelect(s.ticker)}
              className={`${LIST_ROW} relative w-full text-left`}
              style={{
                gap: 8,
                paddingLeft: 14,
                paddingRight: 12,
                paddingTop: 8,
                paddingBottom: 8,
                ...(isSel ? { borderColor: 'rgba(232,196,106,0.45)', background: 'rgba(255,255,255,0.055)' } : null),
              }}
            >
              {isSel && (
                <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full" style={{ background: GOLD.solid }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[13px] font-semibold text-bright">{s.ticker}</span>
                  {s.reacting ? <PulseDot color={AMBER} /> : s.moving ? <PulseDot color={up ? UP : DOWN} /> : null}
                </div>
                <div className="truncate text-[10px] text-subtle">{s.name}</div>
              </div>
              <div className="text-right">
                <Flash value={s.price} className="block font-mono text-[13px] tabular-nums text-foreground">
                  {usd(s.price)}
                </Flash>
                <div className={`font-mono text-[10px] tabular-nums ${up ? 'text-up' : 'text-destructive'}`}>{pct(s.pct)}</div>
              </div>
            </button>
          )
        })}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Center — dedicated stock view (chart + order ticket + relevant news)
// ---------------------------------------------------------------------------

function PriceTooltip({ active, payload, label }: { active?: boolean; payload?: any[]; label?: number }) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-lg border border-white/10 bg-[#0a0a0a] px-3 py-2 text-[11px] shadow-xl">
      <div className="mb-0.5 font-mono text-subtle">{clock(label ?? 0)}</div>
      <div className="font-mono tabular-nums text-bright">{usd(payload[0].value)}</div>
    </div>
  )
}

function OrderTicket({ price }: { price: number }) {
  const [side, setSide] = useState<Side>('Long')
  const [qty, setQty] = useState(10)
  const [leverage, setLeverage] = useState(5)
  const [placed, setPlaced] = useState(false)

  const orderValueUsd = price * qty
  const marginInr = (orderValueUsd / leverage) * USD_INR
  const liq = liquidationPrice(price, leverage, side)

  function place() {
    setPlaced(true)
    window.setTimeout(() => setPlaced(false), 1600)
  }

  return (
    <div className="flex flex-col gap-2.5 px-5 py-3">
      <div className="grid grid-cols-2 gap-2">
        {(['Long', 'Short'] as const).map((s) => {
          const on = side === s
          const active =
            s === 'Long'
              ? 'border-up/50 bg-up/10 text-up'
              : 'border-destructive/50 bg-destructive/10 text-destructive'
          return (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`rounded-lg border py-2 text-sm font-medium transition-colors ${
                on ? active : 'border-white/10 bg-white/[0.02] text-muted hover:bg-white/[0.04]'
              }`}
            >
              {s}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.16em] text-subtle">Quantity</span>
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 0))}
            className={`${INPUT} font-mono tabular-nums`}
            style={{ paddingTop: 8, paddingBottom: 8 }}
          />
        </label>
      </div>

      <div>
        <span className="mb-1 block text-[10px] uppercase tracking-[0.16em] text-subtle">Leverage</span>
        <div className="flex gap-1.5">
          {LEVERAGES.map((lv) => {
            const on = lv === leverage
            return (
              <button
                key={lv}
                onClick={() => setLeverage(lv)}
                className={`flex-1 rounded-full border py-1.5 font-mono text-xs tabular-nums transition-colors ${
                  on ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/10 text-muted hover:bg-white/[0.04]'
                }`}
              >
                {lv}x
              </button>
            )
          })}
        </div>
      </div>

      <dl className="flex flex-col gap-1 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-xs">
        <Row label="Order Value" value={usd(orderValueUsd)} />
        <Row label="Margin Required" value={inr(marginInr)} />
        <Row label="Est. Liquidation" value={usd(liq)} tone={side === 'Long' ? 'destructive' : 'up'} />
      </dl>

      <button
        onClick={place}
        className="group relative rounded-full p-px transition-transform duration-300 active:scale-[0.99]"
        style={{ background: GOLD.gradient, backgroundSize: '250% 250%' }}
      >
        <span className="relative flex items-center justify-center rounded-full bg-[rgba(8,7,6,0.96)] px-6 py-2.5 text-sm font-medium text-bright transition-colors duration-300 group-hover:bg-[rgba(20,17,14,0.88)]">
          {placed ? 'Order Placed ✓' : `Place ${side} Order`}
        </span>
      </button>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'destructive' }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-subtle">{label}</dt>
      <dd className={`font-mono tabular-nums ${tone === 'up' ? 'text-up' : tone === 'destructive' ? 'text-destructive' : 'text-foreground'}`}>
        {value}
      </dd>
    </div>
  )
}

function StockView({
  stock,
  history,
  elapsed,
  fired,
}: {
  stock: DisplayStock
  history: ReturnType<typeof useSimulation>['history']
  elapsed: number
  fired: FiredNews[]
}) {
  const [tf, setTf] = useState<TF>('5m')
  const windowS = TIMEFRAMES.find((t) => t.k === tf)!.s
  const series = history.filter((p) => p.t >= elapsed - windowS).map((p) => ({ t: p.t, price: p[stock.ticker] }))
  const up = stock.pct >= 0
  const lineColor = up ? UP : DOWN
  const relevant = fired.filter((fn) => newsAffects(fn.item, stock.ticker, stock.sector))

  const status = stock.reacting
    ? { text: 'Reaction window — frozen, act now', cls: 'text-amber-300' }
    : stock.moving
      ? { text: 'Pricing in news — live move', cls: up ? 'text-up' : 'text-destructive' }
      : { text: 'Static — no active news', cls: 'text-subtle' }

  const glow = stock.reacting
    ? 'rgba(251,191,36,0.35)'
    : stock.moving
      ? up
        ? 'rgba(34,197,94,0.30)'
        : 'rgba(212,24,61,0.30)'
      : null

  return (
    <motion.section
      initial={MOTION.card.initial}
      animate={MOTION.card.animate}
      transition={{ duration: 0.5, delay: 0.06, ease: EASE }}
      className={`${CARD} min-h-0`}
      style={{
        boxShadow: glow ? `${CARD_SHADOW}, 0 0 46px -10px ${glow}` : CARD_SHADOW,
        borderTopColor: 'rgba(232,196,106,0.5)',
        borderTopWidth: 2,
      }}
    >
      {/* Header: ticker + big price */}
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/[0.06] px-5 py-3.5">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xl font-semibold text-bright">{stock.ticker}</span>
            {stock.reacting ? <PulseDot color={AMBER} /> : stock.moving ? <PulseDot color={lineColor} /> : null}
          </div>
          <div className="mt-0.5 text-[11px] text-subtle">
            {stock.name} · {stock.sector}
          </div>
          <div className={`mt-1 text-[11px] ${status.cls}`}>{status.text}</div>
        </div>
        <div className="text-right">
          <Flash value={stock.price} className="font-mono text-4xl font-semibold tabular-nums text-bright">
            {usd(stock.price)}
          </Flash>
          <div className={`mt-1 font-mono text-sm tabular-nums ${up ? 'text-up' : 'text-destructive'}`}>{pct(stock.pct)}</div>
        </div>
      </header>

      {/* Timeframe toggle */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] px-5 py-2">
        {TIMEFRAMES.map((t) => {
          const on = t.k === tf
          return (
            <button
              key={t.k}
              onClick={() => setTf(t.k)}
              className={`rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
                on ? 'bg-white/[0.08] text-bright' : 'text-subtle hover:text-muted'
              }`}
            >
              {t.k}
            </button>
          )
        })}
      </div>

      {/* Scrollable body: chart (the visual anchor) + order ticket + headlines */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="h-[42vh] min-h-[280px] shrink-0 p-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 10, right: 12, bottom: 2, left: -4 }}>
            <defs>
              <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={lineColor} stopOpacity={0.22} />
                <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={clock}
              stroke="#71717a"
              tick={{ fontSize: 10, fontFamily: 'monospace' }}
              tickLine={false}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              minTickGap={44}
            />
            <YAxis
              dataKey="price"
              domain={['auto', 'auto']}
              tickFormatter={usdAxis}
              orientation="right"
              stroke="#71717a"
              tick={{ fontSize: 10, fontFamily: 'monospace' }}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip content={<PriceTooltip />} />
            <Area
              type="monotone"
              dataKey="price"
              stroke={lineColor}
              strokeWidth={2}
              fill="url(#areaFill)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Order ticket for this stock */}
      <div className="shrink-0 border-t border-white/[0.06]">
        <div className="flex items-center justify-between px-5 pt-3">
          <h3 className="text-[11px] uppercase tracking-[0.18em] text-subtle">Order Ticket</h3>
          <span className="font-mono text-[11px] text-[#E8C46A]">{stock.ticker}</span>
        </div>
        <OrderTicket price={stock.price} />
      </div>

      {/* Relevant news for this stock */}
      <div className="shrink-0 border-t border-white/[0.06]">
        <div className="px-5 pb-1 pt-3 text-[11px] uppercase tracking-[0.18em] text-subtle">Headlines · {stock.ticker}</div>
        <div className="px-3 pb-3">
          {relevant.length === 0 ? (
            <div className="px-2 py-3 text-[11px] text-subtle">No headlines affecting {stock.ticker} yet.</div>
          ) : (
            relevant.map((fn) => {
              const d = stockTargetDelta(fn.item, stock.ticker, stock.sector)
              return (
                <div key={fn.item.id} className="mb-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <PhaseBadge fired={fn} />
                    <span className={`font-mono text-[11px] tabular-nums ${d >= 0 ? 'text-up' : 'text-destructive'}`}>
                      {pct(d * 100)}
                    </span>
                  </div>
                  <div className="mt-1 text-[12px] leading-snug text-zinc-200">{fn.item.headline}</div>
                </div>
              )
            })
          )}
        </div>
      </div>
      </div>
    </motion.section>
  )
}

// ---------------------------------------------------------------------------
// Right — account, positions, news
// ---------------------------------------------------------------------------

function AccountSummary({ positions, priceOf }: { positions: Position[]; priceOf: (t: string) => number }) {
  const totalPnlUsd = positions.reduce((a, p) => a + positionPnlUsd(p, priceOf(p.ticker)), 0)
  const totalPnlInr = totalPnlUsd * USD_INR
  const marginUsedInr = positions.reduce((a, p) => a + marginUsedUsd(p), 0) * USD_INR
  const equity = STARTING_CASH_INR + totalPnlInr
  const available = equity - marginUsedInr

  return (
    <Panel title="Account · INR" delay={0.06} layout="auto">
      <div className="grid grid-cols-2 gap-px bg-white/[0.06]">
        <Tile label="Equity" value={<Flash value={equity}>{inr(equity)}</Flash>} big />
        <Tile label="Available Margin" value={<Flash value={available}>{inr(available)}</Flash>} />
        <Tile label="Margin Used" value={<Flash value={marginUsedInr}>{inr(marginUsedInr)}</Flash>} />
        <Tile
          label="Total P&L"
          value={<Flash value={totalPnlInr}>{inrSigned(totalPnlInr)}</Flash>}
          tone={totalPnlInr >= 0 ? 'up' : 'destructive'}
          big
        />
      </div>
    </Panel>
  )
}

function Tile({ label, value, tone, big }: { label: string; value: ReactNode; tone?: 'up' | 'destructive'; big?: boolean }) {
  return (
    <div className="bg-background/60 px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-subtle">{label}</div>
      <div
        className={`mt-1 font-mono tabular-nums ${big ? 'text-lg' : 'text-[15px]'} ${
          tone === 'up' ? 'text-up' : tone === 'destructive' ? 'text-destructive' : 'text-bright'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function PositionsTable({
  positions,
  priceOf,
  onClose,
}: {
  positions: Position[]
  priceOf: (t: string) => number
  onClose: (id: string) => void
}) {
  return (
    <Panel
      title="Positions"
      right={<span className="font-mono text-[10px] text-subtle">{positions.length}</span>}
      delay={0.12}
      layout="auto"
    >
      <div className="flex min-h-0 flex-col gap-1 p-2">
        <div className="flex items-center gap-2 px-3 pb-1 text-[9px] uppercase tracking-wider text-subtle">
          <span className="w-[58px]">Instr</span>
          <span className="w-[40px] text-right">Sz×L</span>
          <span className="w-[54px] text-right">Entry</span>
          <span className="flex-1 text-right">P&L</span>
          <span className="w-[80px] text-right">Liq.</span>
          <span className="w-4" />
        </div>

        {positions.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-subtle">No open positions.</div>
        ) : (
          positions.map((p) => {
            const price = priceOf(p.ticker)
            const pnlInr = positionPnlUsd(p, price) * USD_INR
            const liq = liquidationPrice(p.entryPrice, p.leverage, p.side)
            const health = liquidationHealth(p, price)
            const long = p.side === 'Long'
            const dotCls = health > 0.5 ? 'bg-up/60' : health > 0.25 ? 'bg-amber-400' : 'bg-destructive'
            const liqCls = health > 0.5 ? 'text-subtle' : health > 0.25 ? 'text-amber-400' : 'text-destructive'
            return (
              <div
                key={p.id}
                className={`${LIST_ROW} text-[11px]`}
                style={{ gap: 8, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}
              >
                <span className="w-[58px]">
                  <span className="block font-mono font-semibold text-bright">{p.ticker}</span>
                  <span className={`text-[9px] font-medium ${long ? 'text-up' : 'text-destructive'}`}>{p.side}</span>
                </span>
                <span className="w-[40px] text-right font-mono tabular-nums text-muted">
                  {p.size}×{p.leverage}
                </span>
                <span className="w-[54px] text-right font-mono tabular-nums text-muted">{usd(p.entryPrice)}</span>
                <Flash
                  value={pnlInr}
                  className={`flex-1 text-right font-mono tabular-nums ${pnlInr >= 0 ? 'text-up' : 'text-destructive'}`}
                >
                  {inrSigned(pnlInr)}
                </Flash>
                <span className="flex w-[80px] items-center justify-end gap-1">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${dotCls} ${health <= 0.25 ? 'animate-pulse' : ''}`}
                    title={`Liquidation health ${(health * 100).toFixed(0)}%`}
                  />
                  <span className={`font-mono tabular-nums ${liqCls}`}>{usd(liq)}</span>
                </span>
                <button
                  onClick={() => onClose(p.id)}
                  aria-label={`Close ${p.ticker}`}
                  className="w-4 text-center text-subtle transition-colors hover:text-destructive"
                >
                  ✕
                </button>
              </div>
            )
          })
        )}
      </div>
    </Panel>
  )
}

function ReactionBanner({ fired }: { fired: FiredNews }) {
  const remaining = Math.ceil(NEWS_WINDOW_SECONDS - fired.secondsSinceFire)
  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
      <div className="flex items-center gap-2 text-amber-300">
        <PulseDot color={AMBER} />
        <span className="text-[11px] font-semibold uppercase tracking-wide">
          {primaryLabels(fired.item).join(', ')} news — price frozen, act now
        </span>
      </div>
      <div className="mt-1 font-mono text-2xl font-semibold tabular-nums text-amber-200">{clock(remaining)}</div>
    </div>
  )
}

function NewsCard({ fired, dim }: { fired: FiredNews; dim: boolean }) {
  return (
    <article
      className={`rounded-lg border px-3 py-2.5 transition-opacity ${
        dim ? 'border-white/[0.05] bg-white/[0.015] opacity-70' : 'border-white/[0.09] bg-white/[0.035]'
      }`}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {impactChips(fired.item).map((c) => (
            <span
              key={c.label}
              className={`rounded border px-1.5 py-0.5 font-mono text-[9px] tabular-nums ${
                c.v >= 0 ? 'border-up/30 text-up' : 'border-destructive/30 text-destructive'
              }`}
            >
              {c.label} {pct(c.v * 100)}
            </span>
          ))}
        </div>
        <span className="shrink-0 font-mono text-[9px] text-subtle">T+{clock(fired.secondsSinceFire)}</span>
      </div>
      <h3 className="text-[13px] font-semibold leading-snug text-zinc-100">{fired.item.headline}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{fired.item.body}</p>
      <div className="mt-2">
        <PhaseBadge fired={fired} />
      </div>
    </article>
  )
}

function NewsFeed({ fired, next, reaction }: Pick<ReturnType<typeof useSimulation>, 'fired' | 'next' | 'reaction'>) {
  return (
    <Panel title="News Feed" delay={0.18} layout="grow" style={{ minHeight: 240 }}>
      <div className="shrink-0 border-b border-white/[0.06] p-3">
        {reaction ? (
          <ReactionBanner fired={reaction} />
        ) : next ? (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-subtle">Next headline in</span>
            <span className="font-mono tabular-nums text-[#E8C46A]">{clock(next.countdown)}</span>
          </div>
        ) : (
          <div className="text-[11px] text-subtle">No further headlines scheduled.</div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {fired.length === 0 ? (
          <div className="px-1 py-4 text-center text-xs text-subtle">Awaiting the first headline…</div>
        ) : (
          fired.map((fn, i) => <NewsCard key={fn.item.id} fired={fn} dim={i > 0} />)
        )}
      </div>
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Terminal() {
  const frame = useSimulation()
  const [selected, setSelected] = useState('')
  const [positions, setPositions] = useState<Position[]>(() => SEED_POSITIONS.map((p) => ({ ...p })))

  // Default to the first instrument until the user picks one.
  const activeTicker = selected || frame.stocks[0]?.ticker || ''
  const activeStock = frame.stocks.find((s) => s.ticker === activeTicker)
  const priceOf = (t: string) => frame.stocks.find((s) => s.ticker === t)?.price ?? 0

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-5 py-2.5">
        <div className="flex items-baseline gap-3">
          <span className="text-lg text-bright" style={EDITORIAL_SERIF}>
            MochaTrade
          </span>
          <span className="text-[11px] text-subtle">IIM Bangalore Trading Competition</span>
        </div>
        <div className="flex items-center gap-5 font-mono text-[11px] text-muted">
          <span className="hidden sm:inline">SEEDED MARKET · LIVE ENGINE SIM</span>
          <span className="flex items-center gap-1.5">
            <PulseDot color={UP} />
            LIVE
          </span>
          <span className="tabular-nums text-foreground">{clock(frame.elapsed)}</span>
        </div>
      </header>

      {/* 3-column layout */}
      <div className="grid min-h-0 flex-1 grid-cols-[272px_1fr_368px] gap-4 p-4">
        {/* Left */}
        <InstrumentList stocks={frame.stocks} selected={activeTicker} onSelect={setSelected} />

        {/* Center */}
        {activeStock ? (
          <StockView stock={activeStock} history={frame.history} elapsed={frame.elapsed} fired={frame.fired} />
        ) : (
          <div className={`${CARD} items-center justify-center`} style={{ boxShadow: CARD_SHADOW }}>
            <span className="text-sm text-subtle">Select a stock to begin.</span>
          </div>
        )}

        {/* Right — panels size to content; the column scrolls if the viewport is short */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <AccountSummary positions={positions} priceOf={priceOf} />
          <PositionsTable
            positions={positions}
            priceOf={priceOf}
            onClose={(id) => setPositions((prev) => prev.filter((p) => p.id !== id))}
          />
          <NewsFeed fired={frame.fired} next={frame.next} reaction={frame.reaction} />
        </div>
      </div>
    </div>
  )
}

export default Terminal
