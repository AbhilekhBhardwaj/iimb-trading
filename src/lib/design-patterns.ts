/**
 * Mochatrade visual language — reusable card/panel idioms.
 *
 * Extracted verbatim from the Mochatrade marketing site
 * (src/app/pages/Blog.tsx, src/app/pages/Leaderboard.tsx,
 * src/app/components/blogTheme.tsx) so the trading terminal can wear the exact
 * same panel/card look. These are the *source* class strings and tokens — pull
 * them into components as needed. Nothing here imports anything, so it's safe to
 * reference from any file.
 *
 * House style at a glance:
 *   - Near-black background (#030303 / #070707 for raised cards).
 *   - Panels = hairline white borders over very-low-opacity white fills.
 *   - Warm GOLD accent (#E8C46A / amber-*) for emphasis, links, hover borders.
 *   - PP Editorial New ultralight (weight 200) serif for display headings.
 *   - Motion via "motion/react": short fade-up entrances on a custom EASE curve.
 */

// ---------------------------------------------------------------------------
// Gold accent
// ---------------------------------------------------------------------------

/**
 * The warm gold accent. The site uses a solid swatch for text/borders/glows and
 * a multi-stop gradient for the "premium" pill borders (Hero CTA, podium #1).
 */
export const GOLD = {
  /** Primary solid accent — hover borders, eyebrows, rank accents. */
  solid: '#E8C46A',
  /** Deeper gold used in gradients. */
  deep: '#D4A850',
  bronze: '#B87D30',
  pale: '#F5E0A0',
  /** Tailwind's amber-* scale is used interchangeably for text/borders. */
  tailwindText: 'text-amber-400/90', // links; hover -> text-amber-300
  tailwindEyebrow: 'text-amber-500/80',
  /**
   * Spinning gradient border (135deg). Apply as a `background` on a `p-px`
   * wrapper with backgroundSize 250% and the `blogGoldSpin` animation.
   */
  gradient:
    'linear-gradient(135deg, #D4A850 0%, #F5E0A0 30%, #B87D30 55%, #E8C46A 78%, #D4A850 100%)',
  /** Radial glow that sits behind gold CTAs (blur ~14px, `blogGoldGlow` pulse). */
  glowRadial:
    'radial-gradient(ellipse, rgba(212,168,80,0.38) 0%, rgba(180,120,40,0.15) 55%, transparent 75%)',
  /** Warm ambient wash behind page headers. */
  ambientHeader:
    'radial-gradient(ellipse 60% 40% at 50% -5%, rgba(212,168,80,0.08) 0%, transparent 60%)',
} as const

// ---------------------------------------------------------------------------
// Motion — everything imported from "motion/react" (the Framer Motion successor)
// ---------------------------------------------------------------------------

/**
 * The signature easing curve used across the site (cubic-bezier).
 * Import `motion` from "motion/react" and pass this as `transition.ease`.
 *
 *   import { motion } from 'motion/react'
 *   <motion.div
 *     initial={{ opacity: 0, y: 16 }}
 *     animate={{ opacity: 1, y: 0 }}
 *     transition={{ duration: 0.6, ease: EASE }}
 *   />
 *
 * Blog cards use the built-in "easeOut" for a snappier list; the Leaderboard
 * (and Hero) use this custom EASE for the more deliberate, weighted feel.
 */
export const EASE = [0.22, 1, 0.36, 1] as const

/**
 * Entrance conventions observed:
 *   - Cards / rows: fade + rise. initial y is 8px (dense rows) → 22px (podium).
 *   - Stagger: delay = index * step, CLAMPED so long lists don't lag.
 *       list rows  -> delay: Math.min(index * 0.02, 0.3)
 *       card grid  -> delay: Math.min(index * 0.05, 0.4)
 *       podium     -> delay: 0.1 + index * 0.1
 *   - Durations: 0.4s (rows/cards) up to 0.7s (headline/podium).
 */
export const MOTION = {
  /** Dense list-row entrance. Spread into a <motion.div>. */
  row: {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    // transition: { duration: 0.4, delay: Math.min(i * 0.02, 0.3), ease: EASE }
  },
  /** Card-grid entrance (Blog uses easeOut here rather than EASE). */
  card: {
    initial: { opacity: 0, y: 16 },
    animate: { opacity: 1, y: 0 },
    // transition: { duration: 0.4, delay: Math.min(i * 0.05, 0.4), ease: 'easeOut' }
  },
  /** Prominent hero/podium entrance. */
  hero: {
    initial: { opacity: 0, y: 22 },
    animate: { opacity: 1, y: 0 },
    // transition: { duration: 0.7, delay: 0.1 + i * 0.1, ease: EASE }
  },
  /** Suggested stagger helpers matching the site's clamps. */
  stagger: {
    row: (i: number) => Math.min(i * 0.02, 0.3),
    card: (i: number) => Math.min(i * 0.05, 0.4),
    podium: (i: number) => 0.1 + i * 0.1,
  },
} as const

// ---------------------------------------------------------------------------
// Panels & cards — the exact Tailwind class strings
// ---------------------------------------------------------------------------

/**
 * PRIMARY CARD (from Blog.tsx BlogCard). Rounded-2xl, hairline white border over
 * a 3%-white fill, gold-tinted border + lighter fill on hover, 300ms transition.
 * Pair with `CARD_SHADOW` (inline style) and optionally the grain overlay.
 */
export const CARD =
  'group relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] transition-all duration-300 hover:border-amber-500/25 hover:bg-white/[0.05]'

/**
 * Inset top highlight + soft drop shadow that gives the card its raised feel.
 * Apply as an inline style since it's a compound box-shadow:
 *   <div className={CARD} style={{ boxShadow: CARD_SHADOW }} />
 */
export const CARD_SHADOW =
  'inset 0 1px 0 rgba(255,255,255,0.06), 0 1px 24px rgba(0,0,0,0.35)'

/**
 * LIST ROW (from Leaderboard.tsx ListRow). Lighter than a card: rounded-xl,
 * 2%-white fill, gold hover border keyed off the solid gold (#E8C46A).
 */
export const LIST_ROW =
  'flex items-center gap-4 rounded-xl border border-white/8 bg-white/[0.02] px-5 py-3.5 transition-colors hover:border-[#E8C46A]/25 hover:bg-white/[0.04]'

/**
 * STATIC PANEL / empty-error state (used for "no results", error boxes).
 * Same skin as a card but no hover, generous padding, centered text.
 */
export const PANEL_STATIC =
  'rounded-2xl border border-white/8 bg-white/[0.02] p-10 text-center'

/**
 * SKELETON fill — the `animate-pulse` placeholder tone used inside loading cards
 * and rows. Compose with a size, e.g. `h-4 w-24 rounded ${SKELETON}`.
 */
export const SKELETON = 'animate-pulse bg-white/[0.05]'

/**
 * TEXT INPUT (from Leaderboard search). Pill, 3%-white fill, gold focus ring.
 */
export const INPUT =
  'w-full rounded-full border border-white/10 bg-white/[0.03] px-5 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition-colors focus:border-[#E8C46A]/40 focus:bg-white/[0.05]'

/**
 * GRADIENT-BORDER SHELL (from Leaderboard PodiumCard / Hero CTA). The gold
 * gradient lives on an outer wrapper with `padding: 1` (a 1px border); the inner
 * element rounds one notch tighter and sits on a raised near-black (#070707).
 *
 *   <div style={{ background: GOLD.gradient, padding: 1, borderRadius: 22 }}>
 *     <div className="rounded-[21px] bg-[#070707] ..." style={{ boxShadow: `0 0 60px -12px rgba(212,168,80,0.30)` }}>
 *       ...
 *     </div>
 *   </div>
 */
export const GRADIENT_SHELL = {
  outerStyle: { background: GOLD.gradient, padding: 1, borderRadius: 22 },
  innerClassName:
    'flex flex-1 flex-col items-center justify-center rounded-[21px] bg-[#070707]',
  /** Inner glow scales with rank importance; #1 uses 0.30 alpha. */
  innerGlow: (alpha = 0.3) => `0 0 60px -12px rgba(212,168,80,${alpha})`,
} as const

// ---------------------------------------------------------------------------
// Display type
// ---------------------------------------------------------------------------

/**
 * Editorial serif heading style (from blogTheme.editorialSerif). PP Editorial
 * New at ultralight 200 with tight tracking. In THIS project the font is wired
 * via --font-display in src/index.css, so prefer the `font-display` Tailwind
 * utility; this object mirrors the exact inline values the marketing site uses.
 */
export const EDITORIAL_SERIF = {
  fontFamily: "'PP Editorial New', 'Cormorant', serif",
  fontWeight: 200,
  letterSpacing: '-0.015em',
  lineHeight: 1.08,
} as const

/** Uppercase amber eyebrow above headings (from blogTheme.Eyebrow). */
export const EYEBROW = {
  className: 'mb-4 inline-block uppercase text-amber-500/80',
  style: { fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.18em' },
} as const

// ---------------------------------------------------------------------------
// Texture overlays
// ---------------------------------------------------------------------------

/**
 * Fractal-noise grain overlay for cards (from blogTheme.CardGrain). Absolutely
 * positioned inside a `relative` card at 30% opacity with `mix-blend-overlay`.
 */
export const CARD_GRAIN = {
  className: 'pointer-events-none absolute inset-0 opacity-30',
  style: {
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E\")",
    backgroundSize: '180px 180px',
    mixBlendMode: 'overlay' as const,
  },
} as const

// ---------------------------------------------------------------------------
// Keyframes needed by the gold CTA (define once in a global <style> or CSS).
// From the marketing site's src/styles/blog.css. Not auto-injected here.
// ---------------------------------------------------------------------------

/**
 * Drop this into a global stylesheet (or a <style> tag) if you use the spinning
 * gold gradient border / pulsing glow:
 *
 *   @keyframes blogGoldSpin {
 *     0%   { background-position: 0% 50%; }
 *     50%  { background-position: 100% 50%; }
 *     100% { background-position: 0% 50%; }
 *   }
 *   @keyframes blogGoldGlow {
 *     0%, 100% { opacity: 0.35; transform: scale(1); }
 *     50%      { opacity: 0.6;  transform: scale(1.12); }
 *   }
 *
 * Usage: animation: 'blogGoldSpin 4s ease infinite' on the gradient border,
 *        animation: 'blogGoldGlow 3s ease-in-out infinite' on the glow layer.
 */
export const GOLD_KEYFRAMES_CSS = `
@keyframes blogGoldSpin {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@keyframes blogGoldGlow {
  0%, 100% { opacity: 0.35; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.12); }
}
`
