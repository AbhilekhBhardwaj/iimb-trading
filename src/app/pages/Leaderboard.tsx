import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, MOTION } from '../../lib/design-patterns'
import { supabase } from '../../lib/supabase'
import { api, type LeaderboardEntry } from '../../lib/api'
import { analytics } from '../../lib/analytics'

// Scoreboard formatters — whole-rupee, big and legible from across a room.
const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr = (v: number) => inrFmt.format(v)
const signedInr = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${inrFmt.format(Math.abs(v))}`
const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`
const tone = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-destructive' : 'text-subtle')

// Podium accents: gold / silver / bronze (silver isn't in the palette, so keep it local).
const SILVER = '#C7CAD1'
const medalColor = (rank: number): string | null =>
  rank === 1 ? GOLD.solid : rank === 2 ? SILVER : rank === 3 ? GOLD.bronze : null

// Shared 4-column grid so the header labels and every row line up exactly.
const COLS = 'grid grid-cols-[2.75rem_1fr_9rem_6.5rem] items-center gap-3 sm:grid-cols-[4rem_1fr_11.5rem_8rem] sm:gap-5'

function ScoreRow({ e, isMe, i }: { e: LeaderboardEntry; isMe: boolean; i: number }) {
  const m = medalColor(e.rank)
  const name = e.teamName ?? e.username
  return (
    <motion.div
      initial={MOTION.row.initial}
      animate={MOTION.row.animate}
      transition={{ duration: 0.35, delay: Math.min(i * 0.02, 0.3), ease: EASE }}
      className={`${COLS} rounded-2xl border px-4 py-2.5 sm:px-6 sm:py-3.5 ${
        isMe ? 'border-[#E8C46A]/55 bg-[#E8C46A]/[0.08]' : m ? 'border-white/12 bg-white/[0.035]' : 'border-white/[0.07] bg-white/[0.015]'
      }`}
      // Podium rows get a thick colored left edge; the shared inset/shadow gives depth.
      style={{ boxShadow: m ? `inset 4px 0 0 ${m}, ${CARD_SHADOW}` : CARD_SHADOW }}
    >
      {/* Rank */}
      <div className="text-center">
        <span className="font-mono text-2xl font-bold tabular-nums sm:text-3xl" style={{ color: m ?? '#e7e7e7' }}>{e.rank}</span>
      </div>

      {/* Team */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold text-bright sm:text-lg">{name}</span>
          {isMe && (
            <span className="shrink-0 rounded-full bg-[#E8C46A]/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[#E8C46A]">You</span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-subtle sm:text-[10px]">{e.username}</div>
      </div>

      {/* Total Portfolio Value */}
      <div className="text-right font-mono text-lg font-semibold tabular-nums text-bright sm:text-xl">{inr(e.equityInr)}</div>

      {/* P&L (₹ + %) */}
      <div className={`text-right ${tone(e.totalPnlInr)}`}>
        <div className="font-mono text-sm font-semibold tabular-nums sm:text-base">{signedInr(e.totalPnlInr)}</div>
        <div className="font-mono text-[11px] tabular-nums opacity-90 sm:text-xs">{pct(e.totalPnlPct)}</div>
      </div>
    </motion.div>
  )
}

function Leaderboard() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<LeaderboardEntry[]>([])
  const [myUsername, setMyUsername] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const booted = useRef(false)

  useEffect(() => {
    analytics.pageview('/leaderboard')
    let alive = true
    let id: number | undefined
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) { navigate('/login', { replace: true }); return }
      // One-time: who am I? (to highlight my own row). Failure is non-fatal.
      try { const b = await api.bootstrap(); if (alive) setMyUsername(b.username) } catch { /* board still works */ }

      const tick = async () => {
        try {
          const { leaderboard } = await api.leaderboard()
          if (alive) { setRows(leaderboard); setLive(true); setError(null); booted.current = true }
        } catch {
          // Keep the last standings on screen; flag reconnecting. Never blank a
          // scoreboard that may be projected for the whole room.
          if (alive) { if (!booted.current) setError('Could not reach the trading server (npm run api).'); else setLive(false) }
        }
      }
      await tick()
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

  return (
    <div className="min-h-screen bg-background text-foreground" style={{ backgroundImage: GOLD.ambientHeader }}>
      {/* Header */}
      <header className="mx-auto flex max-w-5xl flex-wrap items-end justify-between gap-4 px-4 pb-6 pt-8 sm:px-6">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-amber-500/80">IIM Bangalore · Trading Competition</div>
          <h1 className="mt-1.5 text-bright" style={{ ...EDITORIAL_SERIF, fontSize: 'clamp(1.85rem, 4vw, 2.75rem)' }}>Leaderboard</h1>
        </div>
        <div className="flex items-center gap-5 font-mono text-[12px]">
          <span className={`flex items-center gap-2 ${live ? 'text-up' : 'text-[#E8C46A]'}`}>
            <span className="relative flex h-2 w-2">
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 ${live ? 'bg-up' : 'bg-[#E8C46A]'}`} />
              <span className={`relative inline-flex h-2 w-2 rounded-full ${live ? 'bg-up' : 'bg-[#E8C46A]'}`} />
            </span>
            {live ? 'LIVE' : 'RECONNECTING…'}
          </span>
          <Link to="/terminal" className="text-muted transition-colors hover:text-bright">← Terminal</Link>
        </div>
      </header>

      {/* Board */}
      <main className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
        {/* Column labels */}
        <div className={`${COLS} px-4 pb-2.5 text-[9px] uppercase tracking-[0.2em] text-subtle sm:px-6`}>
          <span className="text-center">Rank</span>
          <span>Team</span>
          <span className="text-right">Portfolio Value</span>
          <span className="text-right">P&amp;L</span>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-12 text-center text-sm text-subtle">
            No teams yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((e, i) => (
              <ScoreRow key={e.username} e={e} isMe={e.username === myUsername} i={i} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

export default Leaderboard
