import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD, INPUT, MOTION } from '../../lib/design-patterns'
import { istTime, roundLabel } from '../../lib/format'
import * as session from '../../lib/session'
import {
  api,
  type Bootstrap,
  type Notification,
  type RoundStatus,
  type ScheduleRound,
  type TeamOverview,
} from '../../lib/api'
import { signOut } from '../../lib/signOut'
import { analytics } from '../../lib/analytics'

const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const inr = (v: number) => inrFmt.format(v)
const inrSigned = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${inrFmt.format(Math.abs(v))}`
const num = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`
// IST, pinned — the master's clock must agree with what teams see.
const clock = (t: number) => istTime(t)
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
  // Draft price per ticker, as a raw string so the field can be genuinely empty
  // while typing. Seeded ONCE from the catalogue — never re-seeded by the 2s
  // poll, which would otherwise wipe whatever the Master is halfway through
  // typing. The live value stays visible in its own column.
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>({})
  const [savingPrices, setSavingPrices] = useState(false)
  // Same seed-once rule as the price drafts: the 2s poll must not overwrite it.
  const [rateDraft, setRateDraft] = useState('')
  const [savingRate, setSavingRate] = useState(false)
  // Commission rate is edited as a PERCENT ("0.30"), stored as a fraction (0.003).
  const [commissionDraft, setCommissionDraft] = useState('')
  const [savingCommission, setSavingCommission] = useState(false)
  // Type-to-confirm for the destructive reset. Deliberately NOT seeded, and
  // cleared after every attempt, so the button is never armed by accident.
  const [resetConfirm, setResetConfirm] = useState('')
  const [resetting, setResetting] = useState(false)
  const toastSeq = useRef(0)
  const ready = useRef(false)
  const draftsSeeded = useRef(false)

  const toast = useCallback((ok: boolean, text: string) => {
    const id = ++toastSeq.current
    setToasts((p) => [...p, { id, ok, text }])
    window.setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000)
  }, [])

  const refresh = useCallback(async () => {
    const [b, s, t, n] = await Promise.all([api.bootstrap(), api.roundSchedule(), api.adminTeams(), api.notificationsList()])
    setBoot(b); setSchedule(s.schedule); setTeams(t.teams); setNotifications(n.notifications)
    // First catalogue we see seeds the price fields; later polls must not.
    if (!draftsSeeded.current && b.instruments.length > 0) {
      draftsSeeded.current = true
      setPriceDrafts(Object.fromEntries(b.instruments.map((i) => [i.ticker, String(i.referencePrice)])))
      // Seed from the round the rate would actually apply to. round.usdInrRate
      // reads the ACTIVE round and falls back to the default between rounds, so
      // it would show 83 even after the Master has pinned something else.
      const tgt = s.schedule.find((r) => r.status === 'active') ?? s.schedule.find((r) => r.status === 'pending')
      setRateDraft(String(tgt?.usdInrRate ?? b.round.usdInrRate))
      setCommissionDraft(((tgt?.commissionRate ?? b.round.commissionRate) * 100).toFixed(2))
    }
  }, [])

  useEffect(() => {
    analytics.pageview('/admin')
    let alive = true
    let id: number | undefined
    ;(async () => {
      if (!session.isAuthenticated()) { navigate('/login', { replace: true }); return }
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
  // Slippage nudge visibility for the round this control targets. Display-only.
  const targetSlippage = target?.slippageEnabled ?? round.slippageEnabled

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
    detail: `Turns commission ${enabled ? 'on' : 'off'} for the ${round.active ? 'current' : 'next'} round (${target ? roundLabel(target.id) : '—'}).`,
    confirmLabel: enabled ? 'Enable' : 'Disable', tone: 'gold',
    run: async () => { try { await api.setCommission(enabled); await refresh(); toast(true, `Commission ${enabled ? 'enabled' : 'disabled'}`) } catch { toast(false, 'Failed to set commission') } },
  })
  // --- Instrument prices ---------------------------------------------------
  // A draft counts as a change only when it parses to a positive number that
  // differs from the live value, so untouched rows are never resubmitted.
  const parsedDraft = (ticker: string): number | null => {
    const raw = (priceDrafts[ticker] ?? '').trim()
    if (raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const isChanged = (ticker: string, current: number): boolean => {
    const n = parsedDraft(ticker)
    return n !== null && n !== current
  }
  const changedTickers = boot.instruments.filter((i) => isChanged(i.ticker, i.referencePrice)).map((i) => i.ticker)

  const applyPrices = async (updates: { ticker: string; price: number }[]) => {
    if (updates.length === 0) { toast(false, 'No price changes to apply'); return }
    setSavingPrices(true)
    try {
      const res = await api.setInstrumentPrices(updates)
      analytics.capture('instrument_prices_set', { count: res.changes.length })
      // Resync the drafts for exactly what changed, so the fields show the
      // committed values rather than the Master's now-stale typing.
      setPriceDrafts((prev) => ({
        ...prev,
        ...Object.fromEntries(res.changes.map((c) => [c.ticker, String(c.newPrice)])),
      }))
      await refresh()
      toast(true, res.changes.length === 1
        ? `${res.changes[0].ticker} set to ${num(res.changes[0].newPrice)}`
        : `${res.changes.length} prices updated`)
    } catch (err) {
      // The server's reason (round active, unknown ticker, bad price) comes
      // through the thrown message.
      toast(false, err instanceof Error ? err.message : 'Failed to set prices')
    } finally {
      setSavingPrices(false)
    }
  }

  const doSetOne = (ticker: string, current: number) => {
    const price = parsedDraft(ticker)
    if (price === null) { toast(false, `Enter a positive price for ${ticker}`); return }
    setPending({
      title: `Set ${ticker} to $${num(price)}?`,
      detail: `Teams will see $${num(price)} as the starting price for the next round, replacing $${num(current)}.`,
      confirmLabel: 'Update', tone: 'gold',
      run: () => applyPrices([{ ticker, price }]),
    })
  }

  const doSetAll = () => {
    const updates = changedTickers.map((t) => ({ ticker: t, price: parsedDraft(t)! }))
    if (updates.length === 0) { toast(false, 'No price changes to apply'); return }
    setPending({
      title: `Set ${updates.length} price${updates.length === 1 ? '' : 's'}?`,
      detail: updates.map((u) => `${u.ticker} → $${num(u.price)}`).join(', ') + '. Applied together; if any is rejected none are.',
      confirmLabel: 'Set Prices', tone: 'gold',
      run: () => applyPrices(updates),
    })
  }

  // --- USD/INR settlement rate ---------------------------------------------
  const parsedRate = (): number | null => {
    const raw = rateDraft.trim()
    if (raw === '') return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  // The rate in force for the round this control targets. NOT round.usdInrRate,
  // which reads the active round and reverts to the default between rounds.
  const targetRate = target?.usdInrRate ?? round.usdInrRate
  // Same rule for the commission rate: read the round this control targets, not
  // the engine default. Displayed as a percentage.
  const commissionRate = target?.commissionRate ?? round.commissionRate
  const rateChanged = parsedRate() !== null && parsedRate() !== targetRate

  const doSetRate = () => {
    const rate = parsedRate()
    if (rate === null) { toast(false, 'Enter a positive USD/INR rate'); return }
    setPending({
      title: `Set USD/INR to ${num(rate)}?`,
      detail: round.active
        ? `Sets ${num(rate)} on ${target ? roundLabel(target.id) : 'this round'}, replacing ${num(targetRate)}, with immediate effect. Fills from now on settle at the new rate; trades already closed keep the rate they settled at.`
        : `Pins ${num(rate)} for ${target ? roundLabel(target.id) : 'the next round'}, replacing ${num(targetRate)}. Every fill in that round settles at this rate.`,
      confirmLabel: 'Set Rate', tone: 'gold',
      run: async () => {
        setSavingRate(true)
        try {
          const res = await api.setUsdInrRate(rate)
          analytics.capture('usd_inr_rate_set', { usdInrRate: rate })
          // Read back the round that changed, not res.round — the latter reports
          // the ACTIVE round's rate, which is the default between rounds.
          setRateDraft(String(res.changed?.usdInrRate ?? rate))
          await refresh()
          toast(true, `USD/INR set to ${num(res.changed?.usdInrRate ?? rate)}`)
        } catch (err) {
          toast(false, err instanceof Error ? err.message : 'Failed to set rate')
        } finally {
          setSavingRate(false)
        }
      },
    })
  }

  // --- Commission rate -------------------------------------------------------
  // Entered as a percentage for legibility; the API takes a fraction.
  const parsedCommission = (): number | null => {
    const raw = commissionDraft.trim().replace(/%$/, '')
    if (raw === '') return null
    const pct = Number(raw)
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null
    return pct / 100
  }
  const commissionChanged =
    parsedCommission() !== null && Math.abs(parsedCommission()! - commissionRate) > 1e-12

  const doSetCommissionRate = () => {
    const rate = parsedCommission()
    if (rate === null) { toast(false, 'Enter a commission rate between 0 and 100%'); return }
    setPending({
      title: `Set commission to ${(rate * 100).toFixed(2)}%?`,
      detail: round.active
        ? `Applies to ${target ? roundLabel(target.id) : 'this round'} immediately, replacing ${(commissionRate * 100).toFixed(2)}%. Fills from now on are charged at the new rate; fills already charged keep theirs.`
        : `Pins ${(rate * 100).toFixed(2)}% for ${target ? roundLabel(target.id) : 'the next round'}, replacing ${(commissionRate * 100).toFixed(2)}%. Charged on every fill regardless of the display toggle.`,
      confirmLabel: 'Set Rate', tone: 'gold',
      run: async () => {
        setSavingCommission(true)
        try {
          const res = await api.setCommissionRate(rate)
          analytics.capture('commission_rate_set', { commissionRate: rate })
          const applied = res.changed?.commissionRate ?? rate
          setCommissionDraft((applied * 100).toFixed(2))
          await refresh()
          toast(true, `Commission set to ${(applied * 100).toFixed(2)}%`)
        } catch (err) {
          toast(false, err instanceof Error ? err.message : 'Failed to set commission rate')
        } finally {
          setSavingCommission(false)
        }
      },
    })
  }

  const doSlippage = (enabled: boolean) => setPending({
    title: `Turn the slippage nudge ${enabled ? 'ON' : 'OFF'}?`,
    detail: `${enabled ? 'Shows' : 'Hides'} the "a limit order could have saved you $X" note in the post-trade popup for the ${round.active ? 'current' : 'next'} round (${target ? roundLabel(target.id) : '—'}). Display only — orders, fills and settlement are unaffected either way.`,
    confirmLabel: enabled ? 'Show' : 'Hide', tone: 'gold',
    run: async () => {
      try {
        await api.setSlippageEnabled(enabled)
        analytics.capture('slippage_toggle_set', { enabled })
        await refresh()
        toast(true, `Slippage nudge ${enabled ? 'shown' : 'hidden'}`)
      } catch (err) {
        toast(false, err instanceof Error ? err.message : 'Failed to set slippage nudge')
      }
    },
  })

  const RESET_WORD = 'RESET'
  const resetArmed = resetConfirm.trim().toUpperCase() === RESET_WORD

  const doResetEvent = () => {
    if (!resetArmed) return
    setPending({
      title: 'Reset the entire event?',
      detail:
        'Permanently deletes ALL trades, orders, positions and notifications, ' +
        'zeroes every team’s realized P&L (returning cash to its starting balance), ' +
        'ends any active round and returns the schedule to all-pending. ' +
        'Accounts, instruments and the audit log are kept. This cannot be undone.',
      confirmLabel: 'Reset Event', tone: 'destructive',
      run: async () => {
        setResetting(true)
        try {
          const res = await api.resetEvent()
          analytics.capture('event_reset', { ...res.cleared })
          const c = res.cleared
          await refresh()
          toast(true, `Event reset — cleared ${c.trades} trades, ${c.orders} orders, ${c.positions} positions, ${c.notifications} notifications, ${c.rounds} rounds`)
        } catch (err) {
          toast(false, err instanceof Error ? err.message : 'Failed to reset event')
        } finally {
          setResetting(false)
          setResetConfirm('') // always disarm, success or failure
        }
      },
    })
  }

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
          <button onClick={async () => { await signOut(); analytics.reset(); navigate('/login', { replace: true }) }} className="text-subtle transition-colors hover:text-destructive">sign out</button>
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
            <Stat label="Round" value={round.active && round.id ? roundLabel(round.id) : '—'} />
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
                    <td className="px-3 py-2 text-bright">{roundLabel(r.id)}</td>
                    <td className="px-3 py-2 text-muted">{r.mode.replace(/_/g, ' ')}</td>
                    <td className={`px-3 py-2 ${r.commissionEnabled ? 'text-[#E8C46A]' : 'text-subtle'}`}>{r.commissionEnabled ? 'ON' : 'OFF'}</td>
                    <td className={`px-3 py-2 text-right uppercase ${r.status === 'active' ? 'text-up' : r.status === 'ended' ? 'text-subtle' : 'text-muted'}`}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* 2. Instrument starting prices */}
        <Panel title="Instrument Starting Prices" delay={0.03}
          right={
            <button
              onClick={doSetAll}
              disabled={round.active || savingPrices || changedTickers.length === 0}
              className="rounded-lg border border-[#E8C46A]/40 bg-[#E8C46A]/10 px-4 py-1.5 text-[12px] font-medium text-[#E8C46A] transition-colors hover:bg-[#E8C46A]/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingPrices ? 'Working…' : `Set Prices${changedTickers.length > 0 ? ` (${changedTickers.length})` : ''}`}
            </button>
          }
        >
          {round.active ? (
            <p className="mb-4 rounded-lg border border-destructive/30 bg-destructive/[0.07] px-3 py-2 text-[12px] text-muted">
              <span className="font-semibold text-destructive">Locked while a round is live.</span>{' '}
              The last price drives margin valuation and the liquidation mark, so moving it mid-round
              could liquidate open positions. End the round to set prices for the next one.
            </p>
          ) : (
            <p className="mb-4 text-[12px] text-muted">
              Sets what teams see as the starting price for the next round. Usable before every round —
              this overrides any price left behind by previous trading.
            </p>
          )}

          <div className="overflow-hidden rounded-lg border border-white/[0.06]">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-white/[0.08] text-[10px] uppercase tracking-wider text-subtle">
                  <th className="px-3 py-2 text-left font-medium">Ticker</th>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-right font-medium">Current</th>
                  <th className="px-3 py-2 text-right font-medium">New Price</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {boot.instruments.map((it) => {
                  const changed = isChanged(it.ticker, it.referencePrice)
                  const raw = (priceDrafts[it.ticker] ?? '').trim()
                  const invalid = raw !== '' && parsedDraft(it.ticker) === null
                  return (
                    <tr key={it.ticker} className={`border-b border-white/[0.04] last:border-0 ${changed ? 'bg-[#E8C46A]/[0.05]' : ''}`}>
                      <td className="px-3 py-2 text-bright">{it.ticker}</td>
                      <td className="px-3 py-2 font-sans text-muted">{it.name}</td>
                      <td className="px-3 py-2 text-right text-muted">${num(it.referencePrice)}</td>
                      <td className="px-3 py-2 text-right">
                        <input
                          value={priceDrafts[it.ticker] ?? ''}
                          onChange={(e) => setPriceDrafts((p) => ({ ...p, [it.ticker]: e.target.value }))}
                          disabled={round.active || savingPrices}
                          inputMode="decimal"
                          aria-label={`New price for ${it.ticker}`}
                          className={`${INPUT} w-28 text-right font-mono disabled:cursor-not-allowed disabled:opacity-40 ${invalid ? 'border-destructive/60' : ''}`}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => doSetOne(it.ticker, it.referencePrice)}
                          disabled={round.active || savingPrices || !changed}
                          className="rounded-md border border-white/10 px-3 py-1 text-[11px] text-muted transition-colors hover:bg-white/[0.06] hover:text-bright disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          Update
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* 3. Half-width row: settlement rate + slippage nudge. Both are round
             configuration the Master may change at any time, including mid-round. */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel title="Settlement Rate (USD/INR)" delay={0.05}
          right={<span className="font-mono text-[11px] text-muted">{round.active ? 'in force' : 'next round'} <span className="text-bright">{num(targetRate)}</span></span>}
        >
          {round.active && (
            <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[12px] text-muted">
              <span className="font-semibold text-amber-300">Round is live.</span>{' '}
              Changing the rate now will affect settlement for trades from this point forward in this
              round — trades already closed are unaffected.
            </p>
          )}
          <p className="mb-4 text-[12px] leading-relaxed text-muted">
            Sets the USD→INR rate. Every fill settles at this rate until changed again — it never
            drifts on its own. Can be changed at any time, including mid-round; a position opened at
            one rate and closed at another realizes the difference as real P&L.
          </p>
          <div className="flex items-end gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-subtle">New rate (₹ per $1)</span>
              <input
                value={rateDraft}
                onChange={(e) => setRateDraft(e.target.value)}
                disabled={savingRate}
                inputMode="decimal"
                aria-label="New USD/INR rate"
                className={`${INPUT} w-40 font-mono disabled:cursor-not-allowed disabled:opacity-40 ${rateDraft.trim() !== '' && parsedRate() === null ? 'border-destructive/60' : ''}`}
              />
            </label>
            <button
              onClick={doSetRate}
              disabled={savingRate || !rateChanged}
              className="rounded-lg border border-[#E8C46A]/40 bg-[#E8C46A]/10 px-4 py-2 text-sm font-medium text-[#E8C46A] transition-colors hover:bg-[#E8C46A]/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {savingRate ? 'Working…' : 'Set Rate'}
            </button>
          </div>
        </Panel>

        {/* 4. Slippage nudge — same pattern as Commission: a display toggle for
             the round, with no effect on matching, fills or settlement. */}
        <Panel title="Slippage Nudge" delay={0.05}>
          <p className="text-[12px] leading-relaxed text-muted">
            Show or hide the slippage note for the <span className="text-bright">{round.active ? 'current' : 'next'}</span> round
            {target ? <span className="font-mono text-subtle"> ({roundLabel(target.id)})</span> : null}.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {[true, false].map((on) => (
              <button key={String(on)} onClick={() => doSlippage(on)}
                className={`rounded-lg border py-3 text-sm font-medium uppercase transition-colors ${targetSlippage === on ? (on ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/20 bg-white/[0.05] text-bright') : 'border-white/10 bg-white/[0.02] text-muted hover:bg-white/[0.04]'}`}>
                {on ? 'On' : 'Off'}{targetSlippage === on ? ' ·  current' : ''}
              </button>
            ))}
          </div>
          <p className="mt-4 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[10px] leading-relaxed text-muted">
            After a market order walks past the best price, the post-trade popup tells the team
            <span className="text-bright"> what a limit order would have saved them</span>. This setting only controls
            whether that note is shown — orders, fills and settlement are identical either way. Nothing appears when a
            market order fills cleanly at one price, or for limit orders.
          </p>
        </Panel>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* 5. Broadcast */}
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

          {/* 6. Commission */}
          <Panel title="Commission" delay={0.1}>
            <p className="text-[12px] leading-relaxed text-muted">
              Show or hide the Commission line for the <span className="text-bright">{round.active ? 'current' : 'next'}</span> round
              {target ? <span className="font-mono text-subtle"> ({roundLabel(target.id)})</span> : null}.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {[true, false].map((on) => (
                <button key={String(on)} onClick={() => doCommission(on)}
                  className={`rounded-lg border py-3 text-sm font-medium uppercase transition-colors ${targetCommission === on ? (on ? 'border-[#E8C46A]/50 bg-[#E8C46A]/10 text-[#E8C46A]' : 'border-white/20 bg-white/[0.05] text-bright') : 'border-white/10 bg-white/[0.02] text-muted hover:bg-white/[0.04]'}`}>
                  {on ? 'On' : 'Off'}{targetCommission === on ? ' ·  current' : ''}
                </button>
              ))}
            </div>
            <p className="mt-4 rounded-md border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[10px] leading-relaxed text-muted">
              Commission is charged on <span className="text-bright">every fill</span> at the rate set below, to both
              sides, and always deducted from realized P&L — every round, regardless of this toggle. This setting only
              controls whether the Commission line is shown to teams in the trade confirmation popup.
              To run a round at no cost, set the rate to <span className="font-mono text-bright">0%</span>.
            </p>

            {/* Commission RATE — separate from the display toggle above. */}
            <div className="mt-4 border-t border-white/[0.06] pt-4">
              <div className="flex items-end gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-subtle">Commission rate (%)</span>
                  <input
                    value={commissionDraft}
                    onChange={(e) => setCommissionDraft(e.target.value)}
                    disabled={savingCommission}
                    inputMode="decimal"
                    aria-label="Commission rate percent"
                    className={`${INPUT} w-32 font-mono disabled:cursor-not-allowed disabled:opacity-40 ${commissionDraft.trim() !== '' && parsedCommission() === null ? 'border-destructive/60' : ''}`}
                  />
                </label>
                <button
                  onClick={doSetCommissionRate}
                  disabled={savingCommission || !commissionChanged}
                  className="rounded-lg border border-[#E8C46A]/40 bg-[#E8C46A]/10 px-4 py-2 text-sm font-medium text-[#E8C46A] transition-colors hover:bg-[#E8C46A]/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingCommission ? 'Working…' : 'Set Rate'}
                </button>
                <span className="ml-auto font-mono text-[11px] text-muted">
                  {round.active ? 'in force' : 'next round'}{' '}
                  <span className="text-bright">{(commissionRate * 100).toFixed(2)}%</span>
                </span>
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-subtle">
                Changeable at any time, including mid-round. Forward-only: fills already charged keep the rate they
                were charged at.
              </p>
            </div>
          </Panel>
        </div>

        {/* 7. Teams */}
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

        {/* 8. Danger zone. Last on the page, red-bordered, and armed only by
             typing RESET — the server independently requires the same word, so
             this is a second gate rather than the only one. */}
        <motion.section
          initial={MOTION.card.initial} animate={MOTION.card.animate} transition={{ duration: 0.45, delay: 0.2, ease: EASE }}
          className={`${CARD} min-h-0 border-destructive/30`} style={{ boxShadow: CARD_SHADOW }}
        >
          <header className="flex shrink-0 items-center justify-between border-b border-destructive/20 px-4 py-2.5">
            <h2 className="text-[11px] uppercase tracking-[0.18em] text-destructive">Danger Zone</h2>
            <span className="font-mono text-[10px] text-subtle">irreversible</span>
          </header>
          <div className="p-4">
            <h3 className="text-[13px] font-medium text-bright">Reset Event</h3>
            <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-muted">
              Returns the platform to a clean starting point so a test run — or a real event that has gone
              wrong — can be restarted without touching the database by hand.
            </p>

            <div className="mt-4 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-destructive">Destroys</div>
                <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted">
                  <li>All trades</li>
                  <li>All orders, including anything resting</li>
                  <li>All positions</li>
                  <li>All notifications and announcements</li>
                  <li>All realized P&amp;L — cash returns to its starting balance</li>
                  <li>All round progress — the schedule returns to all-pending</li>
                </ul>
              </div>
              <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-subtle">Keeps</div>
                <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted">
                  <li>Team accounts and logins</li>
                  <li>Instruments and their starting prices</li>
                  <li>The audit log, including this reset</li>
                </ul>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-subtle">
                  Type <span className="font-mono text-destructive">{RESET_WORD}</span> to enable
                </span>
                <input
                  value={resetConfirm}
                  onChange={(e) => setResetConfirm(e.target.value)}
                  disabled={resetting}
                  autoComplete="off"
                  aria-label={`Type ${RESET_WORD} to enable the reset`}
                  className={`${INPUT} w-44 font-mono uppercase tracking-[0.14em] disabled:cursor-not-allowed disabled:opacity-40 ${resetArmed ? 'border-destructive/60' : ''}`}
                />
              </label>
              <button
                onClick={doResetEvent}
                disabled={!resetArmed || resetting}
                className="rounded-lg border border-destructive/50 bg-destructive/15 px-5 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/25 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.02] disabled:text-subtle disabled:opacity-60"
              >
                {resetting ? 'Resetting…' : 'Reset Event'}
              </button>
              <p className="text-[11px] text-subtle">
                {resetArmed ? 'Armed — you will still be asked to confirm.' : 'Disabled until the word matches.'}
              </p>
            </div>
          </div>
        </motion.section>
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
