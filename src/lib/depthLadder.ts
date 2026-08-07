/**
 * Depth-ladder scroll maths, kept pure so it can be tested without a DOM.
 *
 * The ladder is ONE continuous scroller: asks stacked above a spread divider,
 * bids below it. That is the right shape — the spread reads as a single line
 * through the middle of the book — but it has a trap. A browser opens every
 * scroller at `scrollTop = 0`, which here is the TOP of the ask stack: the
 * furthest-away, least interesting offers. With 30 levels a side and a short
 * panel, the spread and every bid sit below the fold, so the ladder looks like
 * it holds two or three lonely levels and nothing else.
 *
 * The fix is to open the ladder where a trader actually looks — centred on the
 * spread — which is what `spreadScrollTop` computes.
 */

export interface LadderMetrics {
  /** Offset of the spread divider from the top of the scrollable content. */
  spreadTop: number
  /** Height of the spread divider itself. */
  spreadHeight: number
  /** Visible height of the scroller. */
  viewportHeight: number
  /** Total height of the content inside the scroller. */
  contentHeight: number
}

/**
 * The `scrollTop` that puts the spread in the middle of the viewport, clamped
 * to the scrollable range so it can never overscroll at either end.
 *
 * Returns 0 when the content fits — there is nothing to scroll, and forcing a
 * non-zero offset on a short book would hide the top of it.
 */
export function spreadScrollTop(m: LadderMetrics): number {
  const maxScroll = m.contentHeight - m.viewportHeight
  if (!Number.isFinite(maxScroll) || maxScroll <= 0) return 0
  // Centre of the spread band, less half a viewport, puts the band mid-screen.
  const ideal = m.spreadTop + m.spreadHeight / 2 - m.viewportHeight / 2
  return Math.max(0, Math.min(maxScroll, Math.round(ideal)))
}

/**
 * Header badge showing how deep each side runs, e.g. `12 × 9`.
 *
 * This is the affordance that answers "is there more below?" without scrolling
 * — the complaint that a short ladder looks empty when it is merely cropped.
 */
export function depthCountLabel(bidLevels: number, askLevels: number): string {
  return `${bidLevels} × ${askLevels}`
}

/**
 * Whether the ladder is showing everything it has.
 *
 * Used to decide if the "scroll for more" hint is worth showing at all; a book
 * that fits should not nag.
 */
export function ladderOverflows(m: Pick<LadderMetrics, 'viewportHeight' | 'contentHeight'>): boolean {
  return m.contentHeight > m.viewportHeight + 1 // 1px of tolerance for sub-pixel layout
}
