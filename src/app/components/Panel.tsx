import { type ReactNode } from 'react'
import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, MOTION } from '../../lib/design-patterns'

/**
 * Card shell used by every Terminal panel (and the lazily-loaded chart). Lives
 * in its own module so the chart chunk can reuse it without importing Terminal.
 */
export function Panel({ title, right, children, className = '', delay = 0, fit = false }: {
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
