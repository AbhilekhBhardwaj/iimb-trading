/**
 * The order popups, shared by every surface that can place an order.
 *
 * The Terminal's order window and the Portfolio's per-position Close action must
 * look and behave identically, so these live here rather than inside either
 * page. The rows they render are built by lib/orderFlow, which both callers use
 * — so there is one implementation of the content as well as the chrome.
 */

import { type ReactNode } from 'react'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, GOLD } from '../../lib/design-patterns'
import { type ConfirmLine } from '../../lib/orderConfirm'

/** Dimmed, blurred modal shell. Clicking the backdrop closes; the card does not. */
export function Overlay({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm" onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}
        className={`${CARD} w-full max-w-sm p-6`} style={{ boxShadow: CARD_SHADOW }} onClick={(e) => e.stopPropagation()}>
        {children}
      </motion.div>
    </div>
  )
}

/** The key/value rows both dialogs render. */
function Rows({ lines }: { lines: ConfirmLine[] }) {
  return (
    <dl className="mt-4 flex flex-col gap-1.5 text-[13px]">
      {lines.map((l) => (
        <div key={l.k} className="flex items-center justify-between">
          <dt className="text-subtle">{l.k}</dt>
          <dd className={`font-mono tabular-nums ${l.tone === 'up' ? 'text-up' : l.tone === 'destructive' ? 'text-destructive' : 'text-foreground'}`}>{l.v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Pre-trade confirmation. Rows come from buildConfirmLines. */
export function ConfirmDialog({ title, lines, confirmLabel, tone, onConfirm, onCancel }: {
  title: string
  lines: ConfirmLine[]
  confirmLabel: string
  tone: 'up' | 'destructive'
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Overlay onClose={onCancel}>
      <h3 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.35rem' }}>{title}</h3>
      <Rows lines={lines} />
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

/** What a fill ACTUALLY did, as opposed to ConfirmDialog's pre-trade estimate. */
export interface TradeResult {
  title: string
  lines: ConfirmLine[]
  note: string | null
}

/**
 * Post-trade result popup. Carries the realized P&L breakdown and the slippage
 * nudge together in one dialog rather than two, since a closing market order can
 * produce both.
 */
export function ResultDialog({ title, lines, note, onClose }: {
  title: string
  lines: ConfirmLine[]
  note?: string | null
  onClose: () => void
}) {
  return (
    <Overlay onClose={onClose}>
      <h3 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '1.35rem' }}>{title}</h3>
      {lines.length > 0 && <Rows lines={lines} />}
      {note && (
        <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: GOLD.solid }}>Slippage</div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{note}</p>
        </div>
      )}
      <button onClick={onClose} className="mt-6 w-full rounded-full border border-white/10 py-2.5 text-sm text-muted transition-colors hover:bg-white/[0.04]">Done</button>
    </Overlay>
  )
}
