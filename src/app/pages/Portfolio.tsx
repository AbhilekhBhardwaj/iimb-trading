import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF } from '../../lib/design-patterns'
import { supabase } from '../../lib/supabase'
import { api, type Portfolio as PortfolioData } from '../../lib/api'

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
  return `${pct >= 0 ? '+' : '−'}${num(Math.abs(pct), 1)}%`
}

const toneClass = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-destructive' : 'text-foreground')

function Portfolio() {
  const navigate = useNavigate()
  const [data, setData] = useState<PortfolioData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bootRef = useRef(false)

  useEffect(() => {
    let alive = true
    let id: number | undefined
    ;(async () => {
      const { data: session } = await supabase.auth.getSession()
      if (!session.session) { navigate('/login', { replace: true }); return }
      const tick = async () => {
        try {
          const p = await api.portfolio()
          if (alive) { setData(p); setError(null); bootRef.current = true }
        } catch {
          if (alive && !bootRef.current) setError('Could not reach the trading server (npm run api).')
        }
      }
      await tick()
      id = window.setInterval(tick, 2000)
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

  const holdings = data.inventory.filter((r) => r.qty != null)
  const gain = data.totalPnlInr

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="flex items-center justify-between border-b border-white/[0.07] px-6 py-3">
        <div className="flex items-baseline gap-3">
          <Link to="/terminal" className="text-lg text-bright transition-colors hover:text-[#E8C46A]" style={EDITORIAL_SERIF}>MochaTrade</Link>
          <span className="text-[11px] uppercase tracking-[0.18em] text-subtle">Portfolio</span>
        </div>
        <Link to="/terminal" className="font-mono text-[11px] text-muted transition-colors hover:text-bright">← Terminal</Link>
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

          <div className="mt-8 max-w-xs">
            <div className="text-[10px] uppercase tracking-[0.16em] text-subtle">Cash Available</div>
            <div className="mt-1 font-mono text-2xl tabular-nums text-bright">{inr(data.cashInr)}</div>
          </div>
        </section>

        {/* SECTION 1 — Open Positions (live) */}
        <section className="mt-14">
          <h2 className="mb-4 text-sm font-medium text-bright">Open Positions</h2>

          {holdings.length === 0 ? (
            <p className="text-sm text-subtle">No open positions</p>
          ) : (
            <div className={`${CARD} overflow-hidden`} style={{ boxShadow: CARD_SHADOW }}>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                    <th className="px-5 py-3 text-left font-medium">Ticker</th>
                    <th className="px-3 py-3 text-right font-medium">Qty</th>
                    <th className="px-3 py-3 text-right font-medium">Avg Entry</th>
                    <th className="px-3 py-3 text-right font-medium">Current</th>
                    <th className="px-3 py-3 text-right font-medium">Market Value</th>
                    <th className="px-5 py-3 text-right font-medium">Unrealized P&L</th>
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
                        <td className="px-3 py-3 text-right text-foreground">{inr(r.currentPriceInr!)}</td>
                        <td className="px-3 py-3 text-right text-foreground">{inr(r.portfolioValueInr!)}</td>
                        <td className={`px-5 py-3 text-right ${toneClass(r.pnlM2mInr!)}`}>{inrSigned(r.pnlM2mInr!)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* SECTION 2 — Trade History (closed / reduced) */}
        <section className="mt-12 border-t border-white/[0.06] pt-10">
          <h2 className="mb-4 text-sm font-medium text-bright">Trade History</h2>

          {data.tradeHistory.length === 0 ? (
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
                    <th className="px-3 py-3 text-right font-medium">Realized P&L</th>
                    <th className="px-5 py-3 text-right font-medium">Closed</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {data.tradeHistory.map((h, i) => (
                    <tr key={`${h.ticker}-${h.closedAt}-${i}`} className="border-b border-white/[0.04] last:border-0">
                      <td className="px-5 py-3 text-left">
                        <span className="font-semibold text-bright">{h.ticker}</span>
                        <span className={`ml-2 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase ${h.side === 'long' ? 'bg-up/10 text-up' : 'bg-destructive/10 text-destructive'}`}>{h.side}</span>
                      </td>
                      <td className="px-3 py-3 text-right text-muted">{inr(h.entryPriceInr)}</td>
                      <td className="px-3 py-3 text-right text-foreground">{inr(h.exitPriceInr)}</td>
                      <td className="px-3 py-3 text-right text-muted">{h.qty}</td>
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
            XIRR <span className={`ml-1.5 font-mono tabular-nums ${data.xirr == null ? 'text-subtle' : toneClass(data.xirr)}`}>{fmtXirr(data.xirr)}</span>
          </span>
          <span className="text-subtle">
            Realized P&L <span className={`ml-1.5 font-mono tabular-nums ${toneClass(data.realizedPnlInr)}`}>{inrSigned(data.realizedPnlInr)}</span>
          </span>
        </section>
      </motion.main>
    </div>
  )
}

export default Portfolio
