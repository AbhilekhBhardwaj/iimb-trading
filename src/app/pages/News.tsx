import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, MOTION } from '../../lib/design-patterns'
import * as session from '../../lib/session'
import { NotificationStrip } from '../components/NotificationStrip'
import { api, type Bootstrap, type InstrumentMeta, type Notification, type ScheduleRound } from '../../lib/api'
import { roundLabel } from '../../lib/format'
import { analytics } from '../../lib/analytics'

// ---------------------------------------------------------------------------
// Broader Stats — placeholder fundamentals. IIMB provides the real per-round
// numbers; to plug them in, replace `placeholderStats` with the real source
// (e.g. a `fundamentals` table keyed by (round_id, ticker)) — the column set
// and round-gating below stay the same.
// ---------------------------------------------------------------------------
const STAT_COLUMNS = [
  { key: 'ev', label: 'EV (₹Cr)' },
  { key: 'ebitda', label: 'EBITDA (₹Cr)' },
  { key: 'de', label: 'D/E' },
  { key: 'pe', label: 'P/E' },
  { key: 'revGrowth', label: 'Rev Growth' },
  { key: 'netMargin', label: 'Net Margin' },
] as const

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 16777619) ^ s.charCodeAt(i)) >>> 0
  return h
}
function placeholderStats(ticker: string, roundIndex: number): Record<(typeof STAT_COLUMNS)[number]['key'], string> {
  const h = hash(`${ticker}:${roundIndex}`)
  const pick = (shift: number, mod: number) => (h >> shift) % mod
  return {
    ev: (8000 + pick(2, 90000)).toLocaleString('en-IN'),
    ebitda: (600 + pick(5, 9000)).toLocaleString('en-IN'),
    de: (0.1 + pick(7, 180) / 100).toFixed(2),
    pe: (9 + pick(9, 550) / 10).toFixed(1),
    revGrowth: `${(pick(11, 500) / 10 - 8).toFixed(1)}%`,
    netMargin: `${(4 + pick(13, 320) / 10).toFixed(1)}%`,
  }
}

function Panel({ title, right, children, delay = 0 }: { title: string; right?: ReactNode; children: ReactNode; delay?: number }) {
  return (
    <motion.section
      initial={MOTION.card.initial} animate={MOTION.card.animate} transition={{ duration: 0.45, delay, ease: EASE }}
      className={`${CARD}`} style={{ boxShadow: CARD_SHADOW }}
    >
      <header className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-subtle">{title}</h2>
        {right}
      </header>
      <div className="p-5">{children}</div>
    </motion.section>
  )
}

function NewsBullets({ items }: { items: Notification[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((n) => (
        <li key={n.id} className="flex gap-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#E8C46A]" />
          <div>
            <div className="text-[14px] leading-snug text-zinc-100">{n.title}</div>
            {n.body && <div className="mt-0.5 text-[12px] leading-relaxed text-subtle">{n.body}</div>}
          </div>
        </li>
      ))}
    </ul>
  )
}

function News() {
  const navigate = useNavigate()
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [schedule, setSchedule] = useState<ScheduleRound[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [archiveId, setArchiveId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const initialized = useRef(false)

  useEffect(() => {
    analytics.pageview('/news')
    let alive = true
    let id: number | undefined
    ;(async () => {
      if (!session.isAuthenticated()) { navigate('/login', { replace: true }); return }
      const tick = async () => {
        try {
          const [b, s, n] = await Promise.all([api.bootstrap(), api.roundSchedule(), api.notificationsList()])
          if (!alive) return
          setBoot(b); setSchedule(s.schedule); setNotifications(n.notifications); setError(null)
          initialized.current = true
        } catch {
          if (alive && !initialized.current) setError('Could not reach the trading server (npm run api).')
        }
      }
      await tick()
      id = window.setInterval(tick, 2000)
    })()
    return () => { alive = false; if (id) window.clearInterval(id) }
  }, [navigate])

  const activeRound = schedule.find((r) => r.status === 'active') ?? null
  const endedRounds = schedule.filter((r) => r.status === 'ended')
  const latestStarted = [...schedule].reverse().find((r) => r.status === 'active' || r.status === 'ended') ?? null

  // Auto-select the most recent past round in the archive when one first appears.
  useEffect(() => {
    if (!archiveId && endedRounds.length) setArchiveId(endedRounds[endedRounds.length - 1].id)
  }, [endedRounds, archiveId])

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
  if (!boot) {
    return <div className="flex min-h-screen items-center justify-center bg-background text-subtle">Loading news…</div>
  }

  const dailyNews = (roundId: string | null) => notifications.filter((n) => n.kind === 'daily_news' && n.roundId === roundId)
  const currentNews = activeRound ? dailyNews(activeRound.id) : []
  const archiveRound = schedule.find((r) => r.id === archiveId) ?? null
  const archiveNews = archiveId ? dailyNews(archiveId) : []
  const instruments: InstrumentMeta[] = boot.instruments
  // Archive lists everything except the live round: past rounds (clickable) + upcoming (locked).
  const archiveList = schedule.filter((r) => r.status !== 'active')

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Nav */}
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-6 py-3">
        <div className="flex items-baseline gap-3">
          <Link to="/terminal" className="text-lg text-bright transition-colors hover:text-[#E8C46A]" style={EDITORIAL_SERIF}>MochaTrade</Link>
          <span className="text-[11px] uppercase tracking-[0.18em] text-subtle">News &amp; Stats</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[11px]">
          <Link to="/portfolio" className="text-muted transition-colors hover:text-bright">Portfolio</Link>
          <Link to="/terminal" className="text-muted transition-colors hover:text-bright">← Terminal</Link>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
          {/* ── DAILY NEWS (current/active round only, no selector) ── */}
          <Panel title="Daily News" delay={0}
            right={activeRound
              ? <span className="flex items-center gap-1.5 font-mono text-[11px] text-up"><span className="relative flex h-1.5 w-1.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-70" /><span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" /></span>R{activeRound.index + 1} · live</span>
              : <span className="font-mono text-[11px] text-subtle">no live round</span>}>
            {!activeRound ? (
              <p className="text-sm text-subtle">No round is live right now. Daily News appears here when a round is running.</p>
            ) : currentNews.length === 0 ? (
              <p className="text-sm text-subtle">No news published yet this round.</p>
            ) : (
              <NewsBullets items={currentNews} />
            )}
          </Panel>

          {/* ── ARCHIVE (past rounds — scrollable list + detail; scales to many rounds) ── */}
          <Panel title="Archive" delay={0.05}
            right={<span className="font-mono text-[11px] text-subtle">{endedRounds.length} past round{endedRounds.length === 1 ? '' : 's'}</span>}>
            {archiveList.length === 0 ? (
              <p className="text-sm text-subtle">No rounds yet — finished rounds will appear here to browse.</p>
            ) : (
              <div className="grid gap-5 sm:grid-cols-[220px_1fr]">
                {/* LEFT — vertical, SCROLLABLE round list. One row per round, so it
                    stays clean whether there are 3 rounds or 13 (list scrolls, no
                    wrapping pill grid). Past = clickable, upcoming = locked. */}
                <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
                  {archiveList.map((r) => {
                    const ended = r.status === 'ended'
                    const sel = r.id === archiveId
                    const count = ended ? dailyNews(r.id).length : 0
                    return (
                      <button
                        key={r.id}
                        disabled={!ended}
                        onClick={() => setArchiveId(r.id)}
                        title={ended ? `View ${roundLabel(r.id)}` : 'Not yet unveiled'}
                        className={`flex shrink-0 items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                          sel ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10'
                            : ended ? 'border-white/10 hover:bg-white/[0.04]'
                            : 'border-white/[0.06] opacity-50'
                        }`}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className={`font-mono text-[13px] ${sel ? 'text-[#E8C46A]' : ended ? 'text-foreground' : 'text-subtle'}`}>{roundLabel(r.id)}</span>
                          <span className="truncate text-[10px] uppercase tracking-wide text-subtle">{r.mode.replace(/_/g, ' ')}</span>
                        </span>
                        {ended
                          ? <span className="ml-2 shrink-0 font-mono text-[10px] text-subtle">{count} item{count === 1 ? '' : 's'}</span>
                          : <span className="ml-2 shrink-0 text-[11px]">🔒</span>}
                      </button>
                    )
                  })}
                </div>

                {/* RIGHT — selected round's news */}
                <div className="min-w-0 sm:border-l sm:border-white/[0.06] sm:pl-5">
                  {endedRounds.length === 0 ? (
                    <p className="text-sm text-subtle">No past rounds to browse yet — finished rounds appear here.</p>
                  ) : !archiveRound || archiveRound.status !== 'ended' ? (
                    <p className="text-sm text-subtle">Select a past round on the left to read its news.</p>
                  ) : (
                    <>
                      <div className="mb-3 font-mono text-[11px] text-subtle">{roundLabel(archiveRound.id)} · {archiveRound.mode.replace(/_/g, ' ')}</div>
                      {archiveNews.length === 0 ? (
                        <p className="text-sm text-subtle">No news was published for this round.</p>
                      ) : (
                        <NewsBullets items={archiveNews} />
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </Panel>

          {/* ── BROADER STATS (round-gated fundamentals) ── */}
          <Panel title="Broader Stats" delay={0.1}
            right={latestStarted ? <span className="font-mono text-[11px] text-subtle">unveiled through R{latestStarted.index + 1}</span> : undefined}>
            {!latestStarted ? (
              <p className="text-sm text-subtle">Fundamentals are unveiled as rounds begin. Nothing has been unveiled yet.</p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                        <th className="px-3 py-2.5 text-left font-medium">Company</th>
                        {STAT_COLUMNS.map((c) => <th key={c.key} className="px-3 py-2.5 text-right font-medium">{c.label}</th>)}
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {instruments.map((ins) => {
                        const stats = placeholderStats(ins.ticker, latestStarted.index)
                        return (
                          <tr key={ins.ticker} className="border-b border-white/[0.04] last:border-0">
                            <td className="px-3 py-2.5 text-left">
                              <span className="font-semibold text-bright">{ins.ticker}</span>
                              <span className="ml-2 font-sans text-[11px] text-subtle">{ins.name}</span>
                            </td>
                            {STAT_COLUMNS.map((c) => <td key={c.key} className="px-3 py-2.5 text-right text-muted">{stats[c.key]}</td>)}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[10px] leading-relaxed text-amber-300/80">
                  Placeholder figures — IIMB provides the real per-round fundamentals. The table structure and round-gating are final; only the numbers get plugged in.
                </p>
              </>
            )}
          </Panel>
        </div>
      </main>

      {/* Persistent bottom strip (reused) */}
      <NotificationStrip notifications={notifications} />
    </div>
  )
}

export default News
