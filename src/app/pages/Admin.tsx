import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, INPUT, MOTION } from '../../lib/design-patterns'
import { supabase } from '../../lib/supabase'
import {
  api,
  type Bootstrap,
  type Notification,
  type RoundStatus,
  type ScheduleRound,
  type TeamOverview,
} from '../../lib/api'
import { analytics } from '../../lib/analytics'

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr = (v: number) => inrFmt.format(v)
const inrSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${inrFmt.format(Math.abs(v))}`
const num = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`
const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false })
const toneClass = (v: number) => (v > 0 ? 'text-up' : v < 0 ? 'text-destructive' : 'text-foreground')

const KINDS = [
  { k: 'announcement', label: 'Announcement' },
  { k: 'daily_news', label: 'Daily News' },
  { k: 'data', label: 'Data' },
] as const

function Panel({ title, right, children, className = '', delay = 0 }: {
  title: string; right?: ReactNode; children: ReactNode; className?: string; delay?: number
}) {
  return (
    <motion.section
      initial={MOTION.card.initial} animate={MOTION.card.animate} transition={{ duration: 0.45, delay, ease: EASE }}
      className={`${CARD} min-h-0 ${className}`} style={{ boxShadow: CARD_SHADOW }}
    >
      <header className="flex shrink-0 items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <h2 className="text-[11px] uppercase tracking-[0.18em] text-subtle">{title}</h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </motion.section>
  )
}

interface Pending { title: string; detail: string; confirmLabel: string; tone: 'up' | 'destructive' | 'gold'; run: () => Promise<void> }

function ConfirmModal({ pending, onClose }: { pending: Pending; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const btn = pending.tone === 'up' ? 'bg-up/20 hover:bg-up/30 text-up' : pending.tone === 'destructive' ? 'bg-destructive/20 hover:bg-destructive/30 text-destructive' : 'bg-[#E8C46A]/20 hover:bg-[#E8C46A]/30 text-[#E8C46A]'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }}
        className={`${CARD} w-full max-w-sm p-6`} style={{ boxShadow: CARD_SHADOW }} onClick={(e) => e.stopPropagation()}>
        <h3 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.35rem' }}>{pending.title}</h3>
        <p className="mt-3 text-sm text-muted">{pending.detail}</p>
        <div className="mt-6 flex gap-2">
          <button disabled={busy} onClick={onClose} className="flex-1 rounded-full border border-white/10 py-2.5 text-sm text-muted transition-colors hover:bg-white/[0.04] disabled:opacity-50">Cancel</button>
          <button disabled={busy} onClick={async () => { setBusy(true); try { await pending.run() } finally { onClose() } }}
            className={`flex-1 rounded-full py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${btn}`}>
            {busy ? 'Working…' : pending.confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  )
}

interface Toast { id: number; ok: boolean; text: string }

function Admin() {
  const navigate = useNavigate()
  const [boot, setBoot] = useState<Bootstrap | null>(null)
  const [schedule, setSchedule] = useState<ScheduleRound[]>([])
  const [teams, setTeams] = useState<TeamOverview[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [kind, setKind] = useState<Notification['kind']>('announcement')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const toastSeq = useRef(0)
  const ready = useRef(false)

  const toast = useCallback((ok: boolean, text: string) => {
    const id = ++toastSeq.current
    setToasts((p) => [...p, { id, ok, text }])
    window.setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000)
  }, [])

  const refresh = useCallback(async () => {
    const [b, s, t, n] = await Promise.all([api.bootstrap(), api.roundSchedule(), api.adminTeams(), api.notificationsList()])
    setBoot(b); setSchedule(s.schedule); setTeams(t.teams); setNotifications(n.notifications)
  }, [])

  useEffect(() => {
    analytics.pageview('/admin')
    let alive = true
    let id: number | undefined
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (!data.session) { navigate('/login', { replace: true }); return }
      try {
        const b = await api.bootstrap()
        if (!alive) return
        if (b.role !== 'master') { navigate('/terminal', { replace: true }); return } // guard: master only
        ready.current = true
        await refresh()
        id = window.setInterval(() => { refresh().catch(() => {}) }, 2000)
      } catch {
        if (alive && !ready.current) setError('Could not reach the trading server (npm run api).')
      }
    })()
    return () => { alive = false; if (id) window.clearInterval(id) }
  }, [navigate, refresh])

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
    return <div className="flex min-h-screen items-center justify-center bg-background text-subtle">Loading master terminal…</div>
  }

  const round: RoundStatus = boot.round
  // Commission target: the active round, else the next pending round.
  const target = schedule.find((r) => r.status === 'active') ?? schedule.find((r) => r.status === 'pending') ?? null
  const targetCommission = target?.commissionEnabled ?? false

  const doStart = () => setPending({
    title: 'Start Next Round?', detail: 'Activates the next pending round. Teams will be able to trade immediately.',
    confirmLabel: 'Start Round', tone: 'up',
    run: async () => { try { const { round } = await api.roundStart(); analytics.capture('round_started', { roundId: round.id, index: round.index, mode: round.mode }); await refresh(); toast(true, 'Round started') } catch { toast(false, 'Failed to start round') } },
  })
  const doEnd = () => setPending({
    title: 'End Current Round?', detail: 'Ends the active round. Order entry will be disabled until the next round starts.',
    confirmLabel: 'End Round', tone: 'destructive',
    run: async () => { try { const { round } = await api.roundEnd(); analytics.capture('round_ended', { roundId: round.id, index: round.index }); await refresh(); toast(true, 'Round ended') } catch { toast(false, 'Failed to end round') } },
  })
  const doCommission = (enabled: boolean) => setPending({
    title: `Turn commission ${enabled ? 'ON' : 'OFF'}?`,
    detail: `Sets commission_enabled = ${enabled} on the ${round.active ? 'current' : 'next'} round (${target?.id ?? '—'}).`,
    confirmLabel: enabled ? 'Enable' : 'Disable', tone: 'gold',
    run: async () => { try { await api.setCommission(enabled); await refresh(); toast(true, `Commission ${enabled ? 'enabled' : 'disabled'}`) } catch { toast(false, 'Failed to set commission') } },
  })
  const doPush = () => {
    if (!title.trim()) { toast(false, 'Enter a title first'); return }
    const label = KINDS.find((x) => x.k === kind)!.label
    setPending({
      title: `Push ${label}?`, detail: `"${title.trim()}"${body.trim() ? ` — ${body.trim()}` : ''}`,
      confirmLabel: 'Push', tone: 'gold',
      run: async () => {
        try {
          await api.pushNotification(kind, title.trim(), body.trim() || undefined)
          setTitle(''); setBody(''); await refresh()
          toast(true, `${label} pushed${kind === 'announcement' ? ' — popup will fire on team terminals' : ''}`)
        } catch { toast(false, 'Failed to push') }
      },
    })
  }

  return (
    <div className="min-h-screen bg-background text-foreground" style={{ backgroundImage: GOLD.ambientHeader }}>
      {/* Control-room header */}
      <header className="flex items-center justify-between border-b border-[#E8C46A]/20 px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-lg text-bright" style={EDITORIAL_SERIF}>MochaTrade</span>
          <span className="rounded-full border border-[#E8C46A]/40 bg-[#E8C46A]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E8C46A]">Master Terminal</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[11px]">
          <span className="text-muted">{boot.username}</span>
          <Link to="/terminal" className="text-subtle transition-colors hover:text-bright">Terminal</Link>
          <button onClick={async () => { await supabase.auth.signOut(); analytics.reset(); navigate('/login', { replace: true }) }} className="text-subtle transition-colors hover:text-destructive">sign out</button>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
        {/* 1. Round control */}
        <Panel title="Round Control" delay={0}
          right={<span className={`flex items-center gap-1.5 font-mono text-[11px] ${round.active ? 'text-up' : 'text-subtle'}`}>
            <span className="relative flex h-1.5 w-1.5"><span className={`absolute inline-flex h-full w-full rounded-full ${round.active ? 'animate-ping bg-up opacity-70' : ''}`} /><span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${round.active ? 'bg-up' : 'bg-subtle'}`} /></span>
            {round.active ? 'LIVE' : 'IDLE'}
          </span>}
        >
          <div className="flex flex-wrap items-center gap-x-10 gap-y-3">
            <Stat label="Round" value={round.active ? `#${(round.index ?? 0) + 1} · ${round.id}` : '—'} />
            <Stat label="Mode" value={round.mode ? round.mode.replace(/_/g, ' ') : '—'} />
            <Stat label="Time Left" value={round.active && round.remainingSeconds != null ? mmss(round.remainingSeconds) : '—'} />
            <Stat label="Commission" value={round.active ? (round.commissionEnabled ? 'ON' : 'OFF') : '—'} tone={round.active && round.commissionEnabled ? 'gold' : undefined} />
            <div className="ml-auto flex gap-2">
              <button onClick={doStart} className="rounded-lg border border-up/40 bg-up/10 px-4 py-2 text-sm font-medium text-up transition-colors hover:bg-up/20">Start Next Round</button>
              <button onClick={doEnd} disabled={!round.active} className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-40">End Round</button>
            </div>
          </div>

          {/* Schedule */}
          <div className="mt-5 overflow-hidden rounded-lg border border-white/[0.06]">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                  <th className="px-3 py-2 text-left font-medium">#</th>
                  <th className="px-3 py-2 text-left font-medium">Round</th>
                  <th className="px-3 py-2 text-left font-medium">Mode</th>
                  <th className="px-3 py-2 text-left font-medium">Commission</th>
                  <th className="px-3 py-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {schedule.map((r) => (
                  <tr key={r.id} className={`border-b border-white/[0.04] last:border-0 ${r.status === 'active' ? 'bg-up/[0.06]' : ''}`}>
                    <td className="px-3 py-2 text-subtle">{r.index + 1}</td>
                    <td className="px-3 py-2 text-bright">{r.id}</td>
                    <td className="px-3 py-2 text-muted">{r.mode.replace(/_/g, ' ')}</td>
                    <td className={`px-3 py-2 ${r.commissionEnabled ? 'text-[#E8C46A]' : 'text-subtle'}`}>{r.commissionEnabled ? 'ON' : 'OFF'}</td>
                    <td className={`px-3 py-2 text-right uppercase ${r.status === 'active' ? 'text-up' : r.status === 'ended' ? 'text-subtle' : 'text-muted'}`}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* 2. Broadcast */}
          <Panel title="Broadcast" delay={0.05}>
            <div className="flex gap-1.5">
              {KINDS.map((x) => (
                <button key={x.k} onClick={() => setKind(x.k)}
                  className={`flex-1 rounded-full border py-1.5 text-[11px] uppercase tracking-wide transition-colors ${kind === x.k ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/10 text-muted hover:bg-white/[0.04]'}`}>
                  {x.label}
                </button>
              ))}
            </div>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Headline / title" className={`${INPUT} mt-3`} style={{ paddingTop: 8, paddingBottom: 8 }} />
            <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Body (optional)" className={`${INPUT} mt-2`} style={{ paddingTop: 8, paddingBottom: 8 }} />
            <button onClick={doPush} className="group relative mt-3 w-full rounded-full p-px transition-transform active:scale-[0.99]" style={{ background: GOLD.gradient, backgroundSize: '250% 250%' }}>
              <span className="relative flex items-center justify-center rounded-full bg-[rgba(8,7,6,0.96)] px-6 py-2 text-sm font-medium text-bright transition-colors group-hover:bg-[rgba(20,17,14,0.88)]">Push</span>
            </button>

            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <div className="mb-1.5 text-[10px] uppercase tracking-[0.16em] text-subtle">Push Log</div>
              <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
                {notifications.length === 0 ? (
                  <div className="py-3 text-center text-[12px] text-subtle">Nothing pushed yet.</div>
                ) : notifications.map((n) => (
                  <div key={n.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className={`text-[9px] font-semibold uppercase tracking-wider ${n.kind === 'announcement' ? 'text-[#E8C46A]' : n.kind === 'daily_news' ? 'text-zinc-300' : 'text-up'}`}>{n.kind.replace('_', ' ')}</span>
                      <span className="font-mono text-[9px] text-subtle">{clock(n.t)}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-zinc-200">{n.title}</div>
                    {n.body && <div className="text-[11px] text-subtle">{n.body}</div>}
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          {/* 3. Commission */}
          <Panel title="Commission" delay={0.1}>
            <p className="text-[12px] leading-relaxed text-muted">
              Toggle commission for the <span className="text-bright">{round.active ? 'current' : 'next'}</span> round
              {target ? <span className="font-mono text-subtle"> ({target.id})</span> : null}.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {[true, false].map((on) => (
                <button key={String(on)} onClick={() => doCommission(on)}
                  className={`rounded-lg border py-3 text-sm font-medium uppercase transition-colors ${targetCommission === on ? (on ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/20 bg-white/[0.05] text-bright') : 'border-white/10 bg-white/[0.02] text-muted hover:bg-white/[0.04]'}`}>
                  {on ? 'On' : 'Off'}{targetCommission === on ? ' ·  current' : ''}
                </button>
              ))}
            </div>
            <p className="mt-4 rounded-md border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[10px] leading-relaxed text-amber-300/80">
              This sets and displays the commission flag. Commission charges are not yet applied to trade P&L — that's a separate follow-up.
            </p>
          </Panel>
        </div>

        {/* 4. Teams */}
        <Panel title="Teams" delay={0.15} right={<span className="font-mono text-[10px] text-subtle">{teams.length}</span>}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                  <th className="px-3 py-2 text-left font-medium">Team</th>
                  <th className="px-3 py-2 text-left font-medium">Account</th>
                  <th className="px-3 py-2 text-right font-medium">Equity</th>
                  <th className="px-3 py-2 text-right font-medium">Total P&L</th>
                  <th className="px-3 py-2 text-right font-medium">%</th>
                  <th className="px-3 py-2 text-right font-medium">Open</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {teams.map((t) => (
                  <tr key={t.username} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-3 py-2 text-left font-sans text-muted">{t.teamName ?? '—'}</td>
                    <td className="px-3 py-2 text-left text-bright">{t.username}</td>
                    <td className="px-3 py-2 text-right text-foreground">{inr(t.equityInr)}</td>
                    <td className={`px-3 py-2 text-right ${toneClass(t.totalPnlInr)}`}>{inrSigned(t.totalPnlInr)}</td>
                    <td className={`px-3 py-2 text-right ${toneClass(t.totalPnlInr)}`}>{t.totalPnlInr >= 0 ? '+' : '−'}{num(Math.abs(t.totalPnlPct), 2)}%</td>
                    <td className="px-3 py-2 text-right text-subtle">{t.openPositions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </main>

      {pending && <ConfirmModal pending={pending} onClose={() => setPending(null)} />}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
            className={`${CARD} min-w-[220px] max-w-xs p-3 text-[12px]`}
            style={{ boxShadow: CARD_SHADOW, borderColor: t.ok ? 'rgba(34,197,94,0.35)' : 'rgba(212,24,61,0.35)' }}>
            <span className={t.ok ? 'text-up' : 'text-destructive'}>{t.text}</span>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'gold' }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-subtle">{label}</div>
      <div className={`mt-0.5 font-mono text-sm tabular-nums ${tone === 'gold' ? 'text-[#E8C46A]' : 'text-bright'}`}>{value}</div>
    </div>
  )
}

export default Admin
