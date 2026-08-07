import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { applyLeveredFill, DEFAULT_COMMISSION_RATE, liquidationPrice, requiredMargin } from '@iimb-trading/engine'
import { CARD, CARD_SHADOW, EDITORIAL_SERIF, GOLD, INPUT, LIST_ROW } from '../../lib/design-patterns'
import { toCashPosition } from '../../lib/orderConfirm'
import { depthCountLabel, spreadScrollTop } from '../../lib/depthLadder'
import {
  cancelLeverage,
  confirmLeverage,
  INITIAL_LEVERAGE,
  isDangerLeverage,
  LEVERAGE_LEVELS,
  type LeverageSelection,
  leverageWarningLines,
  leverageWarningText,
  selectLeverage,
} from '../../lib/leverage'
import { buildConfirmLines, buildTradeOutcome, estimateFill, type MarketContext, previewPrice } from '../../lib/orderFlow'
import { supabase } from '../../lib/supabase'
import { NotificationStrip } from '../components/NotificationStrip'
import { ConfirmDialog, Overlay, RejectDialog, type RejectionResult, ResultDialog, type TradeResult } from '../components/OrderDialogs'
import { Panel } from '../components/Panel'
import PriceChart from './PriceChart'
import { CANDLE_SPAN, DOWN, intervalOf, type TF, UP, usd } from './terminalShared'
import {
  api,
  type Bootstrap,
  type DepthView,
  type InstrumentRow,
  type Notification,
  type OrderType,
  type Side,
  type Snapshot,
} from '../../lib/api'
import { analytics } from '../../lib/analytics'

// PriceChart is imported EAGERLY (not React.lazy) — once a team is in /terminal
// the chart must already be downloaded, never risking a failed lazy-chunk fetch
// mid-event. It stays in its own module purely for readability.

// UP/DOWN, usd, TF, TIMEFRAMES, intervalOf, CANDLE_SPAN now live in ./terminalShared
// (shared with the lazy PriceChart chunk).

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
const clockHMS = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })
function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Shared shell bits — Panel moved to ../components/Panel (shared with the lazy
// PriceChart chunk so the chart never pulls Terminal into its bundle).
// ---------------------------------------------------------------------------
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
function RoundBar({ snap, username, role, live, onSignOut }: {
  snap: Snapshot | null
  username: string
  role: string
  live: boolean
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
        {/* Connection heartbeat: amber "Reconnecting…" while snapshot polls are
            failing. Last-known data stays on screen the whole time. */}
        {!live && (
          <span className="flex items-center gap-1.5 text-[#E8C46A]" title="Network hiccup — retrying automatically">
            <PulseDot color="#E8C46A" />Reconnecting…
          </span>
        )}
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
        {/* Pinned settlement rate. Quiet by design, but always visible: every
            trade settles at this rate, so teams need to be able to see it. */}
        {r && (
          <span className="tabular-nums text-subtle" title="USD/INR settlement rate — fixed for this round">
            USD/INR <span className="text-muted">{r.usdInrRate.toFixed(2)}</span>
          </span>
        )}
        <span className="text-subtle">·</span>
        <Link to="/portfolio" className="text-muted transition-colors hover:text-[#E8C46A]">Portfolio</Link>
        <span className="text-subtle">·</span>
        <Link to="/leaderboard" className="text-muted transition-colors hover:text-[#E8C46A]">Leaderboard</Link>
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
interface PendingOrder { side: Side; type: OrderType; qty: number; price: number; leverage: number; requiredInr: number; liq: number | null; closes: boolean; fillableQty?: number }


function OrderWindow({ ticker, row, roundActive, rate, depth, onConfirmPlace }: {
  ticker: string
  row: InstrumentRow | undefined
  roundActive: boolean
  rate: number
  /** Live book for this instrument, with the account's own quantity marked. */
  depth: DepthView | null
  onConfirmPlace: (o: PendingOrder) => void
}) {
  const [side, setSide] = useState<Side>('buy')
  const [type, setType] = useState<OrderType>('limit')
  // Qty/Price are stored as raw strings so the field can be genuinely EMPTY
  // while typing — we never coerce '' → 0/1 on a keystroke. Parsing/validation
  // happens only at submit time.
  const [qtyStr, setQtyStr] = useState('10')
  const [priceStr, setPriceStr] = useState('')
  const [alertMsg, setAlertMsg] = useState<string | null>(null)
  // Leverage lives as {applied, pending}: 1x-5x apply on click, 6x/7x stage a
  // pending choice that only becomes `applied` once the warning is confirmed.
  // Everything below reads `applied`, so an order placed while the warning is
  // open still goes out at the OLD leverage.
  const [lev, setLev] = useState<LeverageSelection>(INITIAL_LEVERAGE)
  const leverage = lev.applied

  const qtyInputRef = useRef<HTMLInputElement>(null)
  const priceInputRef = useRef<HTMLInputElement>(null)
  const refocusRef = useRef<'qty' | 'price' | null>(null) // which field to refocus after the popup

  const ltp = row?.ltp ?? 0
  // Keep the limit price synced to LTP until the user edits it.
  const edited = useRef(false)
  useEffect(() => { edited.current = false }, [ticker])
  useEffect(() => { if (!edited.current) setPriceStr(ltp > 0 ? ltp.toFixed(2) : '') }, [ltp])

  // Parsed values. A blank/whitespace field parses to NaN (never 0), so "empty"
  // is treated as not-yet-filled rather than a valid zero.
  const qtyNum = qtyStr.trim() === '' ? NaN : Math.floor(Number(qtyStr))
  const priceNum = priceStr.trim() === '' ? NaN : Number(priceStr)
  // Preview off the BOOK, never the last traded price. A market order walks the
  // visible depth for its own size, discounting quantity resting under this
  // account (self-trade prevention will never fill it against itself). A limit
  // order previews at its own price — that price is the instruction.
  const est = type === 'market' ? estimateFill(depth, side, qtyNum) : null
  const px = previewPrice({ type, side, limitPrice: priceNum, qty: qtyNum, depth, ltp })
  // What will ACTUALLY trade. A market remainder is discarded by the engine, so
  // a market order bigger than the book trades less than it asked for; a LIMIT
  // remainder rests and still reserves margin, so limits stay at full size.
  const bookKnown = type === 'market' && depth !== null && Number.isFinite(qtyNum) && qtyNum > 0
  const fillableQty = est ? est.fillableQty : bookKnown ? 0 : qtyNum
  const existing = row?.position
    ? { qty: row.position.qty, avgPrice: row.position.avgPrice, leverage: row.position.leverage }
    : { qty: 0, avgPrice: 0, leverage }
  const signedQty = side === 'buy' ? fillableQty : -fillableQty
  const valid = Number.isFinite(fillableQty) && fillableQty > 0 && Number.isFinite(px) && px > 0
  // Still computed for the confirm popup (not shown in this panel).
  const requiredInr = (valid ? requiredMargin(existing, signedQty, px, leverage) : 0) * rate
  const resulting = valid ? applyLeveredFill(existing, signedQty, px, leverage) : null
  const closes = !!resulting && existing.qty !== 0 && resulting.qty === 0
  const liq = resulting && resulting.qty !== 0 ? liquidationPrice(resulting) : null
  const priceColor = side === 'buy' ? UP : DOWN

  function submit() {
    // Validate ONLY here (not on keystroke). Prefer the "blank" wording, naming
    // whichever field(s) are actually empty.
    const qtyBlank = qtyStr.trim() === ''
    const priceBlank = type === 'limit' && priceStr.trim() === ''
    if (qtyBlank || priceBlank) {
      const which = qtyBlank && priceBlank ? 'Quantity and Price' : qtyBlank ? 'Quantity' : 'Price'
      refocusRef.current = qtyBlank ? 'qty' : 'price'
      setAlertMsg(`${which} can't be left blank.`)
      return
    }
    // Non-blank but otherwise unusable (0, negative, NaN).
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      refocusRef.current = 'qty'
      setAlertMsg('Quantity must be a number greater than 0.')
      return
    }
    if (type === 'limit' && (!Number.isFinite(priceNum) || priceNum <= 0)) {
      refocusRef.current = 'price'
      setAlertMsg('Price must be a number greater than 0.')
      return
    }
    onConfirmPlace({ side, type, qty: qtyNum, price: px, leverage, requiredInr, liq, closes, fillableQty })
  }

  function dismissAlert() {
    const field = refocusRef.current
    refocusRef.current = null
    setAlertMsg(null)
    // Return focus to the offending field once the modal has unmounted.
    requestAnimationFrame(() => {
      (field === 'price' ? priceInputRef : qtyInputRef).current?.focus()
    })
  }

  return (
    <>
      <Panel title="Order Window" delay={0.06} fit>
        <div className="flex flex-col gap-1 px-4 pt-1 pb-1.5">
          {/* Selected Script */}
          <div className="flex items-baseline justify-between">
            <span className="text-[9px] uppercase tracking-[0.14em] text-subtle">Selected Script</span>
            <span className="font-mono text-sm font-semibold text-[#E8C46A]">{ticker || '—'}</span>
          </div>

          {/* Buy / Sell */}
          <div className="grid grid-cols-2 gap-2">
            {(['buy', 'sell'] as const).map((s) => {
              const on = side === s
              const cls = s === 'buy' ? 'border-up/50 bg-up/10 text-up' : 'border-destructive/50 bg-destructive/10 text-destructive'
              return (
                <button key={s} onClick={() => setSide(s)}
                  className={`rounded-lg border py-1.5 text-sm font-medium uppercase transition-colors ${on ? cls : 'border-white/10 bg-white/[0.02] text-muted hover:bg-white/[0.04]'}`}>
                  {s}
                </button>
              )
            })}
          </div>

          {/* Leverage. A sibling of the Qty/Price block, NOT inside it — the
              stretched Limit/Market column depends on that container's exact
              geometry. 6x/7x carry a red tint at rest to mark the tier before
              anyone clicks, and STAY red when selected: an armed dangerous
              level must never read as a normal, safe state. */}
          <div className="pt-0.5">
            <span className="block text-[9px] uppercase leading-none tracking-[0.14em] text-subtle">Leverage</span>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {LEVERAGE_LEVELS.map((lv) => {
                const on = leverage === lv
                const danger = isDangerLeverage(lv)
                const cls = danger
                  ? on
                    ? 'border-destructive/60 bg-destructive/15 text-destructive'
                    : 'border-destructive/30 bg-destructive/[0.06] text-destructive/70 hover:bg-destructive/10'
                  : on
                    ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]'
                    : 'border-white/10 bg-white/[0.02] text-muted hover:bg-white/[0.04]'
                return (
                  <button key={lv} onClick={() => setLev((prev) => selectLeverage(prev, lv))}
                    aria-pressed={on}
                    className={`rounded-md border py-1 font-mono text-[10px] leading-none tabular-nums transition-colors ${cls}`}>
                    {lv}x
                  </button>
                )
              })}
            </div>
          </div>

          {/* Qty/Price and the submit button share a left column so the
              Limit/Market toggles can stretch down the full height of BOTH rows
              rather than just the input row — which also pulls the submit button
              in from the right edge. */}
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="mb-0.5 block text-[9px] uppercase tracking-[0.14em] text-subtle">Qty</span>
                  <input ref={qtyInputRef} type="number" min={1} value={qtyStr}
                    onChange={(e) => setQtyStr(e.target.value)}
                    className={`${INPUT} font-mono tabular-nums`} style={{ paddingTop: 4, paddingBottom: 4 }} />
                </label>
                <label className="flex-1">
                  <span className="mb-0.5 block text-[9px] uppercase tracking-[0.14em] text-subtle">Price</span>
                  <input ref={priceInputRef} type="number" step="0.01" disabled={type === 'market'}
                    value={type === 'market' ? (px > 0 ? px.toFixed(2) : '') : priceStr}
                    onChange={(e) => { edited.current = true; setPriceStr(e.target.value) }}
                    className={`${INPUT} font-mono tabular-nums disabled:opacity-50`} style={{ paddingTop: 4, paddingBottom: 4, color: priceColor }} />
                </label>
              </div>

              {/* Minimal submit — kept comfortably tall/tappable on purpose. Enabled
                  whenever a round is active so an empty field surfaces the popup. */}
              <button
                disabled={!roundActive}
                onClick={submit}
                className={`rounded-lg border py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  side === 'buy' ? 'border-up/40 bg-up/10 text-up hover:bg-up/20' : 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
                }`}>
                {roundActive ? `Place ${side.toUpperCase()} Order` : 'Waiting for round…'}
              </button>
            </div>

            <div className="flex w-20 flex-col gap-1.5 self-stretch pt-[15px]">
              {(['limit', 'market'] as const).map((t) => (
                <button key={t} onClick={() => setType(t)}
                  className={`flex-1 rounded-md border text-[10px] uppercase tracking-wide transition-colors ${type === t ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/10 text-muted hover:bg-white/[0.04]'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Panel>

      {/* Danger-zone gate. Until Confirm is pressed `lev.applied` is untouched,
          so cancelling genuinely reverts rather than merely hiding the dialog. */}
      {lev.pending !== null && (
        <ConfirmDialog
          title="High Leverage Warning"
          tone="destructive"
          confirmLabel={`Use ${lev.pending}x Leverage`}
          onCancel={() => setLev((prev) => cancelLeverage(prev))}
          onConfirm={() => setLev((prev) => confirmLeverage(prev))}
          lines={leverageWarningLines(lev.pending, { side, price: px, qty: qtyNum, usdInrRate: rate })}
          note={leverageWarningText(lev.pending)}
        />
      )}

      {alertMsg && (
        <Overlay onClose={dismissAlert}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-destructive">Incomplete Order</div>
          <h3 className="mt-2 text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.35rem' }}>{alertMsg}</h3>
          <button onClick={dismissAlert} autoFocus
            className="mt-6 w-full rounded-full border border-white/10 py-2.5 text-sm text-muted transition-colors hover:bg-white/[0.04]">
            OK
          </button>
        </Overlay>
      )}
    </>
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
      {/* Laid out for height, not decoration: six metrics in TWO rows of three
          rather than three rows of two, and a single-line placeholder note.
          That buys back more room than the panel gained from the grid split,
          without costing any other panel a pixel. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {row ? (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-lg font-semibold text-bright">{row.ticker}</span>
              <span className="text-[11px] text-subtle">{row.name} · {row.sector}</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-px overflow-hidden rounded-lg bg-white/[0.06]">
              {metrics.map((m) => (
                <div key={m.k} className="bg-background/60 px-3 py-2">
                  <div className="truncate text-[9px] uppercase tracking-[0.14em] text-subtle">{m.k}</div>
                  <div className="mt-0.5 font-mono text-[13px] tabular-nums text-muted">{m.v}</div>
                </div>
              ))}
            </div>
            <p className="mt-2 truncate rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-1.5 text-[10px] leading-none text-amber-300/80"
              title="Illustrative placeholder — real fundamentals are not wired yet and these figures are not final.">
              Illustrative placeholder — fundamentals not wired yet.
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
// PriceChart (and lightweight-charts + buildCandles) moved to ./PriceChart and
// is loaded lazily via React.lazy above, so the charting library ships in its
// own chunk and only downloads when /terminal renders.

// ---------------------------------------------------------------------------
// Right 2 — market depth (+ market-maker resting-order list)
// ---------------------------------------------------------------------------
const DEPTH_LEVELS = 30 // per side; the ladder scrolls within its panel to reveal depth

/** Shared 3-column grid: bid-size | central price | ask-size. */
const LADDER_COLS = 'grid grid-cols-[1fr_84px_1fr] items-center'

function DepthLadder({ snap, role, ticker }: { snap: Snapshot | null; role: string; ticker: string }) {
  const depth = snap?.depth
  // Zero-qty levels are already excluded upstream. Asks ascending (best/lowest
  // first); bids descending (best/highest first). Both sides nearest the spread.
  const asks = [...(depth?.asks ?? [])].sort((a, b) => a.price - b.price).slice(0, DEPTH_LEVELS)
  const bids = [...(depth?.bids ?? [])].sort((a, b) => b.price - a.price).slice(0, DEPTH_LEVELS)
  const maxQty = Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty))
  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : null
  const resting = role === 'market_maker' ? depth?.restingOrders : undefined
  const empty = asks.length === 0 && bids.length === 0

  // The ladder is one continuous scroller, so it opens at the TOP of the ask
  // stack — the furthest-away offers — with the spread and every bid below the
  // fold. Centre the spread instead, and stop doing so the moment the user
  // scrolls for themselves so the 2s poll can never yank the view back.
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const spreadRef = useRef<HTMLDivElement | null>(null)
  const autoTopRef = useRef(0)
  const userScrolledRef = useRef(false)

  useLayoutEffect(() => {
    userScrolledRef.current = false // a new instrument is a fresh book
  }, [ticker])

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const spreadEl = spreadRef.current
    if (!scroller || !spreadEl || userScrolledRef.current) return
    const box = spreadEl.getBoundingClientRect()
    const top = spreadScrollTop({
      // Offset WITHIN the scrolled content — offsetTop would measure from the
      // panel (the nearest positioned ancestor), not from the scroller.
      spreadTop: box.top - scroller.getBoundingClientRect().top + scroller.scrollTop,
      spreadHeight: box.height,
      viewportHeight: scroller.clientHeight,
      contentHeight: scroller.scrollHeight,
    })
    autoTopRef.current = top
    scroller.scrollTop = top
  }, [ticker, empty, asks.length, bids.length])

  return (
    <Panel
      title="Market Depth"
      delay={0.06}
      right={
        <span className="flex items-center gap-2">
          {/* How deep each side runs. Answers "is there more below?" without
              having to scroll to find out. */}
          <span className="font-mono text-[10px] tabular-nums text-subtle">{depthCountLabel(bids.length, asks.length)}</span>
          {role === 'market_maker' && <span className="text-[9px] uppercase tracking-wider text-[#E8C46A]">MM · full book</span>}
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col p-2 text-[11px]">
        <div className={`${LADDER_COLS} shrink-0 px-2 pb-1 text-[9px] uppercase tracking-wider text-subtle`}>
          <span className="text-right">Bid Size</span>
          <span className="text-center">Price</span>
          <span className="text-left">Ask Size</span>
        </div>

        {empty ? (
          <div className="flex flex-1 items-center justify-center text-subtle">No resting orders.</div>
        ) : (
          <div
            ref={scrollerRef}
            onScroll={(e) => {
              // Only a scroll that lands somewhere we did not put it counts as
              // the user taking over; assigning scrollTop also fires this.
              if (Math.abs(e.currentTarget.scrollTop - autoTopRef.current) > 2) userScrolledRef.current = true
            }}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1"
          >
            {/* ASKS above the spread — lowest (best) sits at the bottom, nearest the line */}
            <div className="flex shrink-0 flex-col gap-px">
              {[...asks].reverse().map((l) => (
                <LadderRow key={`a${l.price}`} price={l.price} qty={l.qty} maxQty={maxQty} side="ask" />
              ))}
            </div>

            {/* Spread divider line */}
            <div ref={spreadRef} className="my-1.5 flex shrink-0 items-center gap-2 px-2">
              <div className="h-px flex-1 bg-white/[0.12]" />
              <span className="font-mono text-[10px] tabular-nums text-subtle">{spread === null ? '—' : usd(spread)}</span>
              <div className="h-px flex-1 bg-white/[0.12]" />
            </div>

            {/* BIDS below the spread — highest (best) sits at the top, nearest the line */}
            <div className="flex shrink-0 flex-col gap-px">
              {bids.map((l) => (
                <LadderRow key={`b${l.price}`} price={l.price} qty={l.qty} maxQty={maxQty} side="bid" />
              ))}
            </div>
          </div>
        )}

        {/* Market maker's per-order view. Its own scroller with a fixed share of
            the panel, so a book with dozens of resting orders is fully reachable
            instead of being capped at the four rows an 80px box allowed. */}
        {resting && resting.length > 0 && (
          <div className="mt-2 flex min-h-0 shrink-0 basis-2/5 flex-col border-t border-white/[0.06] pt-2">
            <div className="mb-1 shrink-0 text-[9px] uppercase tracking-[0.16em] text-subtle">Resting Orders ({resting.length})</div>
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1">
              {resting.map((o) => (
                <div key={o.orderId} className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
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
  const [result, setResult] = useState<TradeResult | null>(null)
  /** A refused order. Modal, like a fill — never a toast that fades away. */
  const [rejected, setRejected] = useState<RejectionResult | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [announcement, setAnnouncement] = useState<Notification | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true) // false → snapshot polling is failing; show "Reconnecting…"
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
        // api.snapshot already retries transient blips internally; if it still
        // throws, the connection is genuinely down for now.
        const s = await api.snapshot(selected, windowSec)
        if (alive) { setSnap(s); setLive(true) } // recovered / healthy
      } catch {
        // Keep the last-known snapshot on screen and flag "Reconnecting…"; the
        // next tick (1s) retries. We never blank the terminal or bounce to an
        // error screen mid-event over a transient hiccup.
        if (alive) setLive(false)
      }
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

  /**
   * The market/account context both dialogs read. Captured fresh at each use so
   * the post-trade figures are measured against the position as it stood BEFORE
   * the fill — the snapshot poll would otherwise have already moved on.
   */
  function marketContext(): MarketContext {
    return {
      position: toCashPosition(row?.position),
      usdInrRate: snap?.rate ?? 83,
      commission: {
        enabled: snap?.round.commissionEnabled ?? false,
        rate: snap?.round.commissionRate ?? DEFAULT_COMMISSION_RATE,
      },
      slippageEnabled: snap?.round.slippageEnabled ?? true,
    }
  }

  async function doPlace(o: PendingOrder) {
    setPending(null)
    analytics.capture('order_placed', { ticker: selected, side: o.side, type: o.type, qty: o.qty, leverage: o.leverage })
    // Capture BEFORE the fill mutates the position.
    const ctx = marketContext()
    try {
      const res = await api.placeOrder({ ticker: selected, side: o.side, type: o.type, price: o.type === 'limit' ? o.price : undefined, qty: o.qty, leverage: o.leverage })
      const filled = (res.trades ?? []).reduce((a, t) => a + t.qty, 0)
      if (res.accepted && filled > 0) analytics.capture('order_filled', { ticker: selected, side: o.side, type: o.type, qty: o.qty, filledQty: filled })

      // The rest vs toast vs dialog decision, the realized breakdown and the
      // slippage nudge all live in lib/orderFlow, so the Portfolio's Close
      // action produces exactly this outcome from exactly this code.
      const outcome = buildTradeOutcome({ ...o, ticker: selected }, ctx, res)
      // A refusal is the loudest thing this flow can produce: same modal weight
      // as a fill, and it stays until dismissed.
      if (outcome.kind === 'reject') {
        analytics.capture('order_rejected', { ticker: selected, side: o.side, type: o.type, qty: o.qty, reason: res.reason, code: outcome.code })
        setRejected({ title: outcome.title, detail: outcome.detail }); return
      }
      if (outcome.kind === 'toast') { pushToast(true, outcome.title, outcome.detail); return }
      if (outcome.note) analytics.capture('slippage_nudge_shown', { ticker: selected, side: o.side, qty: outcome.filledQty })
      setResult({ title: outcome.title, lines: outcome.lines, note: outcome.note })
    } catch {
      // A POST is not auto-retried (it may have landed). Flag the connection and
      // tell the user to check the book before resubmitting, so we never risk a
      // duplicate order. The snapshot poll will clear "Reconnecting…" once back.
      setLive(false)
      pushToast(false, 'Network hiccup', 'Order not confirmed — check the book before retrying.')
    }
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
      <RoundBar snap={snap} username={boot.username} role={boot.role} live={live} onSignOut={async () => { await supabase.auth.signOut(); analytics.reset(); navigate('/login', { replace: true }) }} />

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4 p-4">
        {/* LEFT column: instruments / order / screener */}
        {/* Screener gains ~25px of allocation; the Instrument List gives up
            ~9-16px. It keeps every row at full height and scrolls as before. */}
        <div className="grid min-h-0 grid-rows-[minmax(0,1.35fr)_auto_minmax(0,0.9fr)] gap-4">
          <InstrumentList rows={rows} selected={selected} onSelect={setSelected} />
          <OrderWindow ticker={selected} row={row} roundActive={roundActive}
            rate={snap?.rate ?? 83} depth={snap?.depth ?? null} onConfirmPlace={setPending} />
          <Screener row={row} />
        </div>

        {/* RIGHT column: chart / depth / times & sales */}
        {/* Depth gets a slightly larger share than before (1.15 → 1.3fr), taken
            from the chart so the column total is unchanged — three visible price
            levels was too few to read a book from. */}
        <div className="grid min-h-0 grid-rows-[minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,0.8fr)] gap-4">
          <PriceChart snap={snap} ticker={selected} ltp={row?.ltp ?? 0} tf={tf} onTf={setTf} />
          <DepthLadder snap={snap} role={boot.role} ticker={selected} />
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
          // Built in lib/orderFlow so the Portfolio's Close action renders the
          // identical dialog from the identical code.
          lines={buildConfirmLines({ ...pending, ticker: selected }, marketContext())}
        />
      )}
      {result && (
        <ResultDialog
          title={result.title}
          lines={result.lines}
          note={result.note}
          onClose={() => setResult(null)}
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
      {rejected && <RejectDialog title={rejected.title} detail={rejected.detail} onClose={() => setRejected(null)} />}

      <Toasts toasts={toasts} />
    </div>
  )
}

export default Terminal
