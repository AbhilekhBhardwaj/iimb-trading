import { motion } from 'motion/react'
import { CARD, CARD_SHADOW, EASE, EDITORIAL_SERIF, EYEBROW, MOTION } from '../../lib/design-patterns'

/**
 * Placeholder destination for the `master` role. The real master/admin console
 * (event control, live event_log feed, round management) lands later; this keeps
 * the login→role redirect end-to-end while wearing the house style.
 */
function Admin() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <motion.div
        initial={MOTION.hero.initial}
        animate={MOTION.hero.animate}
        transition={{ duration: 0.7, ease: EASE }}
        className={`${CARD} w-full max-w-md p-10 text-center`}
        style={{ boxShadow: CARD_SHADOW }}
      >
        <span className={EYEBROW.className} style={EYEBROW.style}>
          Master
        </span>
        <h1 className="text-bright" style={{ ...EDITORIAL_SERIF, fontSize: '2rem' }}>
          Master Terminal
        </h1>
        <p className="mt-3 text-sm text-muted">Coming soon.</p>
        <p className="mt-1 text-[12px] text-subtle">
          Event control, live diagnostics, and round management will live here.
        </p>
      </motion.div>
    </main>
  )
}

export default Admin
