import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { DEFAULT_COMMISSION_RATE } from '@iimb-trading/engine'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, INPUT } from '../../lib/design-patterns'
import { supabase } from '../../lib/supabase'
import { api, type InventoryRow, type OrderType, type Portfolio as PortfolioData, type WorkingOrder } from '../../lib/api'
import { ConfirmDialog, Overlay, RejectDialog, type RejectionResult, ResultDialog, type TradeResult } from '../components/OrderDialogs'
import { toCashPosition } from '../../lib/orderConfirm'
import { buildCancelLines, buildConfirmLines, buildTradeOutcome, closingOrderFor, type MarketContext, type OrderTerms } from '../../lib/orderFlow'
import { usd } from '../../lib/format'
import { analytics } from '../../lib/analytics'

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr = (v: number) => inrFmt.format(v)
const inrSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${inrFmt.format(Math.abs(v))}`
const num = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const dtLabel = (t: number) =>
  new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function fmtXirr(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '—'
  const pct = x * 100
  if (Math.abs(pct) >= 1e6) return x > 0 ? '>+999,999%' : '<−999,999%'
  // Round to 1 dp FIRST, then choose the sign from the ROUNDED value. This kills
  // the spurious "−0.0%": when equity equals the opening balance, Newton–Raphson
  // returns a numerically-tiny negative (~−7e-9), which rounds to 0.0 but would
  // otherwise keep its minus sign. A genuine zero now reads as a clean "0.0%".
  const rounded = Math.round(pct * 10) / 10
  if (rounded === 0) return '0.0%'
  return `${rounded > 0 ? '+' : '−'}${num(Math.abs(rounded), 1)}%`
}

/** Neutral tone for a value that rounds to zero, so a clean 0.0% never shows red. */
function xirrTone(x: number | null): string {
  if (x === null || Math.round(x * 1000) / 1000 === 0) return 'text-subtle'
  return toneClass(x)
}

const toneClass = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-destructive' : 'text-foreground')

function Portfolio() {
  const navigate = useNavigate()
  const [data, setData] = useState<PortfolioData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true) // false → polling is failing; show "Reconnecting…"
  const bootRef = useRef(false)
  // Close-from-Portfolio state. `closing` is the row being closed; qty/type are
  // its editable draft so a partial close is possible. `pending` and `result`
  // drive the SAME dialogs the Terminal uses.
  const [closing, setClosing] = useState<InventoryRow | null>(null)
  const [closeQty, setCloseQty] = useState('')
  const [closeType, setCloseType] = useState<OrderType>('market')
  /** Limit price draft, seeded from the mark when the Exit panel opens. */
  const [closePrice, setClosePrice] = useState('')
  const [pending, setPending] = useState<OrderTerms | null>(null)
  const [result, setResult] = useState<TradeResult | null>(null)
  /** A refused exit order. Modal, matching the Terminal exactly. */
  const [rejected, setRejected] = useState<RejectionResult | null>(null)
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)
  /** The working order awaiting cancel confirmation, and the one in flight. */
  const [cancelling, setCancelling] = useState<WorkingOrder | null>(null)
  const [cancelBusy, setCancelBusy] = useState<string | null>(null)

  useEffect(() => {
    analytics.pageview('/portfolio')
    let alive = true
    let id: number | undefined
    ;(async () => {
      const { data: session } = await supabase.auth.getSession()
      if (!session.session) { navigate('/login', { replace: true }); return }
      const tick = async () => {
        try {
          const p = await api.portfolio()
          if (alive) { setData(p); setError(null); setLive(true); bootRef.current = true }
        } catch {
          // Before first successful load → show the error screen. After that, keep
          // the last data on screen and just flag "Reconnecting…"; next tick retries.
          if (alive) {
            if (!bootRef.current) setError('Could not reach the trading server (npm run api).')
            else setLive(false)
          }
        }
      }
      await tick()
      // 1.5s, near the Terminal's 1s. Not 1s: portfolio() is the heaviest
      // endpoint (four DB round-trips including a full trades replay) and every
      // account polls it, so the extra load buys little over 1.5s.
      id = window.setInterval(tick, 1500)
    })()
    return () => { alive = false; if (id) window.clearInterval(id) }
  }, [navigate])

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <div className={`${CARD} max-w-sm p-8`} style={{ boxShadow: CARD_SHADOW }}>
          <h1 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.4rem' }}>Server unavailable</h1>
          <p className="mt-3 text-sm text-muted">{error}</p>
          <Link to="/terminal" className="mt-6 inline-block rounded-full border border-white/10 px-5 py-2 text-sm text-muted transition-colors hover:bg-white/[0.04]">Back to Terminal</Link>
        </div>
      </div>
    )
  }
  if (!data) {
    return <div className="flex min-h-screen items-center justify-center bg-background text-subtle">Loading portfolio…</div>
  }

  // Normalised in api.portfolio(); `?? []` is a second line of defence so a
  // malformed payload degrades to an empty section instead of a blank page.
  const holdings = (data.inventory ?? []).filter((r) => r.qty != null)
  const gain = data.totalPnlInr

  // ---------------------------------------------------------------------------
  // Close a position without leaving this page. Everything below delegates to
  // lib/orderFlow, so the dialogs and the placement path are the Terminal's.
  // ---------------------------------------------------------------------------
  const marketContext = (row: InventoryRow): MarketContext => ({
    position: toCashPosition({
      qty: row.qty!,
      avgPrice: row.avgPrice!,
      leverage: row.leverage ?? 1,
      costBasisInr: row.costBasisInr!,
    }),
    usdInrRate: data.rate,
    commission: { enabled: data.commissionEnabled, rate: data.commissionRate ?? DEFAULT_COMMISSION_RATE },
    slippageEnabled: data.slippageEnabled,
  })

  /**
   * The exit order. Direction is DERIVED from the position sign, never chosen —
   * that is why the row shows one neutral "Exit" rather than Buy/Sell.
   */
  const termsFor = (row: InventoryRow, qty: number, type: OrderType, price: number): OrderTerms | null => {
    const close = closingOrderFor({ qty: row.qty! })
    if (!close) return null
    return {
      ticker: row.ticker,
      side: close.side,
      type,
      qty,
      price, // limit price, or the mark as a market estimate
      leverage: row.leverage ?? 1,
      requiredInr: -1, // a reduce/close frees margin
      liq: null,
      closes: qty >= Math.abs(row.qty!),
    }
  }

  const openExit = (row: InventoryRow) => {
    setClosing(row)
    setCloseQty(String(Math.abs(row.qty!))) // default to the FULL position
    setCloseType('market')
    setClosePrice(row.ltp > 0 ? row.ltp.toFixed(2) : '')
  }

  const submitClose = () => {
    if (!closing) return
    const qty = Math.floor(Number(closeQty))
    const max = Math.abs(closing.qty!)
    if (!Number.isFinite(qty) || qty <= 0 || qty > max) {
      setToast({ ok: false, text: `Quantity must be between 1 and ${max}` })
      return
    }
    // A market exit prices off the mark; a limit exit uses the typed price.
    const price = closeType === 'limit' ? Number(closePrice) : closing.ltp
    if (closeType === 'limit' && (!Number.isFinite(price) || price <= 0)) {
      setToast({ ok: false, text: 'Enter a limit price greater than 0' })
      return
    }
    const terms = termsFor(closing, qty, closeType, price)
    if (terms) setPending(terms)
  }

  const placeClose = async (o: OrderTerms) => {
    setPending(null)
    const row = closing
    setClosing(null)
    if (!row) return
    const ctx = marketContext(row) // captured BEFORE the fill moves the position
    analytics.capture('order_placed', { ticker: o.ticker, side: o.side, type: o.type, qty: o.qty, from: 'portfolio' })
    try {
      const res = await api.placeOrder({
        ticker: o.ticker, side: o.side, type: o.type,
        price: o.type === 'limit' ? o.price : undefined, qty: o.qty, leverage: o.leverage,
      })
      const outcome = buildTradeOutcome(o, ctx, res)
      // Same modal the Terminal shows, from the same outcome — an exit that is
      // refused must never look like an exit that worked.
      if (outcome.kind === 'reject') {
        analytics.capture('order_rejected', { ticker: o.ticker, side: o.side, qty: o.qty, reason: res.reason, code: outcome.code, from: 'portfolio' })
        setRejected({ title: outcome.title, detail: outcome.detail }); return
      }
      if (outcome.kind === 'toast') setToast({ ok: true, text: `${outcome.title} — ${outcome.detail}` })
      else setResult({ title: outcome.title, lines: outcome.lines, note: outcome.note })
      const p = await api.portfolio() // reflect the fill immediately
      setData(p)
    } catch {
      setLive(false)
      setToast({ ok: false, text: 'Network hiccup — order not confirmed, check the Terminal before retrying.' })
    }
  }

  /** Cancel a resting order, then refresh — same shape as the Exit flow. */
  const doCancel = async (o: WorkingOrder) => {
    setCancelling(null)
    setCancelBusy(o.orderId)
    analytics.capture('order_cancelled', { ticker: o.ticker, side: o.side, remainingQty: o.remainingQty, from: 'portfolio' })
    try {
      const res = await api.cancelOrder(o.orderId)
      setToast(
        res.cancelled
          ? { ok: true, text: `Cancelled ${o.remainingQty} ${o.ticker} — margin released` }
          // Already filled or swept between render and click; the refresh below
          // will drop it from the list either way.
          : { ok: false, text: `Could not cancel — the order is no longer working` },
      )
      setData(await api.portfolio())
    } catch {
      setLive(false)
      setToast({ ok: false, text: 'Network hiccup — cancel not confirmed, check the Terminal.' })
    } finally {
      setCancelBusy(null)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="flex items-center justify-between border-b border-white/[0.07] px-6 py-3">
        <div className="flex items-baseline gap-3">
          <Link to="/terminal" className="text-lg text-bright transition-colors hover:text-[#E8C46A]" style={EDITORIAL_SERIF}>MochaTrade</Link>
          <span className="text-[11px] uppercase tracking-[0.18em] text-subtle">Portfolio</span>
        </div>
        <div className="flex items-center gap-4">
          {!live && (
            <span className="flex items-center gap-1.5 font-mono text-[11px] text-[#E8C46A]" title="Network hiccup — retrying automatically">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#E8C46A]" />Reconnecting…
            </span>
          )}
          <Link to="/terminal" className="font-mono text-[11px] text-muted transition-colors hover:text-bright">← Terminal</Link>
        </div>
      </header>

      <motion.main
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}
        className="mx-auto max-w-3xl px-6 py-12"
      >
        {/* TOP — account summary */}
        <section>
          <div className="text-[11px] uppercase tracking-[0.2em] text-subtle">Total Portfolio Value</div>
          <div className="mt-1.5 font-mono text-5xl font-semibold tabular-nums text-bright">{inr(data.totalPortfolioValueInr)}</div>
          <div className={`mt-2.5 flex items-center gap-2 font-mono text-lg tabular-nums ${toneClass(gain)}`}>
            <span>{gain > 0 ? '▲' : gain < 0 ? '▼' : '•'}</span>
            <span>{inrSigned(gain)}</span>
            <span className="text-subtle">·</span>
            <span>{gain >= 0 ? '+' : '−'}{num(Math.abs(data.totalPnlPct), 2)}%</span>
          </div>

          {/* Commission sits beside cash, not inside Trade History: IIMB wants the
              total always visible, and it is charged on EVERY fill regardless of
              whether the confirmation popup itemises it. The history table below
              lists closing fills only, so its Charges column sums to less than
              this figure whenever an opening fill was charged. */}
          <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-subtle">Cash Available</div>
              <div className="mt-1 font-mono text-2xl tabular-nums text-bright">{inr(data.cashInr)}</div>
            </div>
            {/* Margin is the reason the top-line value never equals cash. Both
                figures were already in the payload and shown nowhere, which made
                a portfolio with most of its money committed look unexplainable:
                large total, small cash, no visible reason. Muted rather than
                bright because this is real money that cannot be spent. */}
            <div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-subtle">Margin Used</div>
              <div className="mt-1 font-mono text-2xl tabular-nums text-muted">{inr(data.marginUsedInr)}</div>
              <div className="mt-1.5 text-[10px] leading-relaxed text-subtle">Posted by open positions.</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-subtle">Margin Reserved</div>
              <div className="mt-1 font-mono text-2xl tabular-nums text-muted">{inr(data.marginReservedInr)}</div>
              <div className="mt-1.5 text-[10px] leading-relaxed text-subtle">Locked by working orders.</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.16em] text-subtle">Commission Charged</div>
              <div className={`mt-1 font-mono text-2xl tabular-nums ${data.chargesInr > 0 ? 'text-destructive' : 'text-bright'}`}>
                {data.chargesInr > 0 ? `−${inr(data.chargesInr)}` : inr(0)}
              </div>
              <div className="mt-1.5 text-[10px] leading-relaxed text-subtle">
                Every fill, opens included. Already deducted from your P&amp;L above.
              </div>
            </div>
          </div>

          <p className="mt-6 max-w-2xl text-[11px] leading-relaxed text-subtle">
            Total Portfolio Value = Cash + Margin Used + Margin Reserved. Margin is not lost — it
            returns when a position closes or an order is cancelled.
          </p>
        </section>

        {/* SECTION 1 — Open Positions.
            Positions are settled in INR at the rate they were entered at and are
            NOT revalued while held, so there is deliberately no unrealized-P&L or
            market-value column here: nothing about an open position changes until
            it is closed. P&L appears in Trade History, on close. */}
        <section className="mt-14">
          <div className="mb-1 flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium text-bright">Open Positions</h2>
            <span className="text-[11px] text-subtle">
              Margin Used <span className="font-mono tabular-nums text-muted">{inr(data.marginUsedInr)}</span>
            </span>
          </div>
          <p className="mb-4 text-[11px] text-subtle">
            Cost basis is fixed at entry. P&amp;L is realised when you close — see Trade History.
          </p>

          {holdings.length === 0 ? (
            <p className="text-sm text-subtle">No open positions</p>
          ) : (
            <div className={`${CARD} overflow-hidden`} style={{ boxShadow: CARD_SHADOW }}>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                    <th className="px-5 py-3 text-left font-medium">Ticker</th>
                    <th className="px-3 py-3 text-right font-medium">Qty</th>
                    <th className="px-3 py-3 text-right font-medium">Entry Price</th>
                    <th className="px-3 py-3 text-right font-medium">Entry Rate</th>
                    <th className="px-5 py-3 text-right font-medium">Cost Basis</th>
                    <th className="px-5 py-3 text-right font-medium">Exit</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {holdings.map((r) => {
                    const long = r.qty! >= 0
                    return (
                      <tr key={r.ticker} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-5 py-3 text-left">
                          <span className="font-semibold text-bright">{r.ticker}</span>
                          <span className={`ml-2 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${long ? 'bg-up/10 text-up' : 'bg-destructive/10 text-destructive'}`}>{long ? 'Long' : 'Short'}</span>
                        </td>
                        <td className={`px-3 py-3 text-right ${long ? 'text-up' : 'text-destructive'}`}>{r.qty}</td>
                        <td className="px-3 py-3 text-right text-muted">{inr(r.avgEntryInr!)}</td>
                        <td className="px-3 py-3 text-right text-subtle">
                          {r.entryRateInr === null ? '—' : `₹${num(r.entryRateInr, 2)}`}
                        </td>
                        <td className="px-5 py-3 text-right text-foreground">{inr(r.costBasisInr!)}</td>
                        <td className="px-5 py-3 text-right">
                          {/* One neutral action on every row. Whether this sells
                              a long or buys back a short is derived from the
                              position, never presented as a choice. */}
                          <button
                            onClick={() => openExit(r)}
                            className="rounded-md border border-white/15 px-3 py-1 text-[11px] font-medium uppercase text-muted transition-colors hover:border-white/25 hover:bg-white/[0.06] hover:text-bright"
                          >
                            Exit
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* SECTION 2 — Working Orders. Sits between positions and history because
            that is the lifecycle order: what you hold, what is still working,
            what has closed. */}
        <section className="mt-12 border-t border-white/[0.06] pt-10">
          <div className="mb-1 flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-medium text-bright">Working Orders</h2>
            <span className="text-[11px] text-subtle">
              Margin Reserved <span className="font-mono tabular-nums text-muted">{inr(data.marginReservedInr)}</span>
            </span>
          </div>
          <p className="mb-4 text-[11px] text-subtle">
            Orders resting on the book. Cancelling releases the margin they reserve; anything already filled stays
            filled.
          </p>

          {(data.workingOrders ?? []).length === 0 ? (
            <p className="text-sm text-subtle">No working orders</p>
          ) : (
            <div className={`${CARD} overflow-hidden`} style={{ boxShadow: CARD_SHADOW }}>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                    <th className="px-5 py-3 text-left font-medium">Ticker</th>
                    <th className="px-3 py-3 text-left font-medium">Side</th>
                    <th className="px-3 py-3 text-left font-medium">Type</th>
                    <th className="px-3 py-3 text-right font-medium">Price</th>
                    <th className="px-3 py-3 text-right font-medium">Qty</th>
                    <th className="px-3 py-3 text-right font-medium">Remaining</th>
                    <th className="px-3 py-3 text-right font-medium">Placed</th>
                    <th className="px-5 py-3 text-right font-medium">Cancel</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {(data.workingOrders ?? []).map((o) => (
                    <tr key={o.orderId} className="border-b border-white/[0.04] last:border-0">
                      <td className="px-5 py-3 text-left font-semibold text-bright">{o.ticker}</td>
                      <td className={`px-3 py-3 text-left ${o.side === 'buy' ? 'text-up' : 'text-destructive'}`}>
                        {o.side.toUpperCase()}
                      </td>
                      <td className="px-3 py-3 text-left uppercase text-subtle">{o.type}</td>
                      <td className="px-3 py-3 text-right text-foreground">{o.price === null ? '—' : usd(o.price)}</td>
                      <td className="px-3 py-3 text-right text-muted">{o.qty}</td>
                      {/* Remaining is what a cancel actually withdraws — highlighted
                          when the order is part-filled so the difference is visible. */}
                      <td className={`px-3 py-3 text-right ${o.remainingQty < o.qty ? 'text-[#E8C46A]' : 'text-muted'}`}>
                        {o.remainingQty}
                      </td>
                      <td className="px-3 py-3 text-right text-subtle">{dtLabel(o.placedAt)}</td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => setCancelling(o)}
                          disabled={cancelBusy === o.orderId}
                          className="rounded-md border border-white/15 px-3 py-1 text-[11px] font-medium uppercase text-muted transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {cancelBusy === o.orderId ? '…' : 'Cancel'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* SECTION 3 — Trade History (closed / reduced) */}
        <section className="mt-12 border-t border-white/[0.06] pt-10">
          <h2 className="mb-4 text-sm font-medium text-bright">Trade History</h2>

          {(data.tradeHistory ?? []).length === 0 ? (
            <p className="text-sm text-subtle">No closed trades yet</p>
          ) : (
            <div className={`${CARD} overflow-hidden`} style={{ boxShadow: CARD_SHADOW }}>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                    <th className="px-5 py-3 text-left font-medium">Ticker</th>
                    <th className="px-3 py-3 text-right font-medium">Entry</th>
                    <th className="px-3 py-3 text-right font-medium">Exit</th>
                    <th className="px-3 py-3 text-right font-medium">Qty</th>
                    <th className="px-3 py-3 text-right font-medium">Charges</th>
                    <th className="px-3 py-3 text-right font-medium">Realized P&L</th>
                    <th className="px-5 py-3 text-right font-medium">Closed</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {(data.tradeHistory ?? []).map((h, i) => (
                    <tr key={`${h.ticker}-${h.closedAt}-${i}`} className="border-b border-white/[0.04] last:border-0">
                      <td className="px-5 py-3 text-left">
                        <span className="font-semibold text-bright">{h.ticker}</span>
                        <span className={`ml-2 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${h.side === 'long' ? 'bg-up/10 text-up' : 'bg-destructive/10 text-destructive'}`}>{h.side}</span>
                      </td>
                      <td className="px-3 py-3 text-right text-muted">{inr(h.entryPriceInr)}</td>
                      <td className="px-3 py-3 text-right text-foreground">{inr(h.exitPriceInr)}</td>
                      <td className="px-3 py-3 text-right text-muted">{h.qty}</td>
                      <td className="px-3 py-3 text-right text-subtle">{h.commissionInr > 0 ? `−${inr(h.commissionInr)}` : '—'}</td>
                      <td className={`px-3 py-3 text-right ${toneClass(h.realizedPnlInr)}`}>{inrSigned(h.realizedPnlInr)}</td>
                      <td className="px-5 py-3 text-right text-subtle">{dtLabel(h.closedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* BOTTOM — quiet secondary line */}
        <section className="mt-14 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-white/[0.06] pt-5 text-[12px]">
          <span className="text-subtle">
            XIRR <span className={`ml-1.5 font-mono tabular-nums ${xirrTone(data.xirr)}`}>{fmtXirr(data.xirr)}</span>
          </span>
          <span className="text-subtle">
            Realized P&L <span className={`ml-1.5 font-mono tabular-nums ${toneClass(data.realizedPnlInr)}`}>{inrSigned(data.realizedPnlInr)}</span>
          </span>
        </section>
      </motion.main>

      {/* Quantity / order-type step. Opens on Close, then hands off to the SAME
          ConfirmDialog the Terminal uses. */}
      {closing && !pending && (
        <Overlay onClose={() => setClosing(null)}>
          <h3 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.35rem' }}>
            Exit {closing.ticker}
          </h3>
          {/* States what they hold, rather than framing buy-vs-sell as a choice. */}
          <p className="mt-2 text-[12px] text-muted">
            <span className="text-bright">{closing.qty! > 0 ? 'Long' : 'Short'}</span>{' '}
            <span className="font-mono text-bright">{Math.abs(closing.qty!)}</span>
            <span className="text-subtle"> · mark </span>
            <span className="font-mono text-bright">{usd(closing.ltp)}</span>
            . Reduce the quantity to exit part of the position.
          </p>

          <div className="mt-4 flex items-end gap-3">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-subtle">Quantity</span>
              <input
                type="number" min={1} max={Math.abs(closing.qty!)}
                value={closeQty}
                onChange={(e) => setCloseQty(e.target.value)}
                aria-label={`Quantity of ${closing.ticker} to exit`}
                className={`${INPUT} font-mono tabular-nums`}
              />
            </label>
            <div className="flex gap-1.5">
              {(['market', 'limit'] as const).map((t) => (
                <button key={t} onClick={() => setCloseType(t)}
                  className={`rounded-md border px-3 py-2 text-[11px] uppercase tracking-wide transition-colors ${
                    closeType === t ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/10 text-muted hover:bg-white/[0.04]'
                  }`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Only a limit exit has a price to set; a market exit takes the mark. */}
          {closeType === 'limit' && (
            <label className="mt-3 flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-subtle">Limit price (USD)</span>
              <input
                type="number" step="0.01" min={0}
                value={closePrice}
                onChange={(e) => setClosePrice(e.target.value)}
                aria-label={`Limit price to exit ${closing.ticker}`}
                className={`${INPUT} font-mono tabular-nums`}
              />
            </label>
          )}

          <button
            onClick={() => setCloseQty(String(Math.abs(closing.qty!)))}
            className="mt-2 text-[11px] text-subtle underline-offset-2 transition-colors hover:text-bright hover:underline"
          >
            Exit the full position
          </button>

          <div className="mt-6 flex gap-2">
            <button onClick={() => setClosing(null)} className="flex-1 rounded-full border border-white/10 py-2.5 text-sm text-muted transition-colors hover:bg-white/[0.04]">Cancel</button>
            <button onClick={submitClose} className="flex-1 rounded-full bg-[#E8C46A]/20 py-2.5 text-sm font-medium text-[#E8C46A] transition-colors hover:bg-[#E8C46A]/30">Review</button>
          </div>
        </Overlay>
      )}

      {/* `closing` is always set alongside `pending` — guarded rather than
          asserted so a stray state combination can never throw mid-trade. */}
      {pending && closing && (
        <ConfirmDialog
          title="Confirm Order"
          tone={pending.side === 'buy' ? 'up' : 'destructive'}
          confirmLabel={`Confirm ${pending.side.toUpperCase()}`}
          onCancel={() => setPending(null)}
          onConfirm={() => placeClose(pending)}
          lines={buildConfirmLines(pending, marketContext(closing))}
        />
      )}

      {/* Cancel confirmation — the SAME dialog the order flow uses, with rows
          from buildCancelLines. Never cancels on a single click. */}
      {cancelling && (
        <ConfirmDialog
          title="Cancel Order?"
          tone="destructive"
          confirmLabel="Cancel Order"
          onCancel={() => setCancelling(null)}
          onConfirm={() => doCancel(cancelling)}
          lines={buildCancelLines(cancelling)}
        />
      )}

      {rejected && <RejectDialog title={rejected.title} detail={rejected.detail} onClose={() => setRejected(null)} />}

      {result && (
        <ResultDialog title={result.title} lines={result.lines} note={result.note} onClose={() => setResult(null)} />
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-50">
          <button onClick={() => setToast(null)}
            className={`${CARD} min-w-[240px] max-w-sm p-3 text-left text-[12px]`}
            style={{ boxShadow: CARD_SHADOW, borderColor: toast.ok ? 'rgba(34,197,94,0.35)' : 'rgba(212,24,61,0.35)' }}>
            <span className={toast.ok ? 'text-up' : 'text-destructive'}>{toast.text}</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default Portfolio
