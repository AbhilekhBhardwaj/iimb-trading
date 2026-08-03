/**
 * Thin PostHog wrapper. If VITE_POSTHOG_KEY is missing/empty, every method is a
 * silent no-op — posthog-js is never initialized or called, so the app runs
 * identically with no analytics locally. Purely additive: it never affects
 * trading logic or control flow.
 */
import posthog from 'posthog-js'

const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com'
const enabled = typeof KEY === 'string' && KEY.length > 0

let started = false

export const analytics = {
  /** Initialize once at app startup. No-op without a key. */
  init(): void {
    if (!enabled || started) return
    posthog.init(KEY as string, {
      api_host: HOST,
      capture_pageview: false, // we send explicit pageviews for the SPA routes below
      autocapture: false, // only the events we choose
    })
    started = true
  },
  identify(id: string, props?: Record<string, unknown>): void {
    if (!enabled || !started) return
    posthog.identify(id, props)
  },
  capture(event: string, props?: Record<string, unknown>): void {
    if (!enabled || !started) return
    posthog.capture(event, props)
  },
  pageview(path: string): void {
    if (!enabled || !started) return
    posthog.capture('$pageview', { $current_url: path })
  },
  reset(): void {
    if (!enabled || !started) return
    posthog.reset()
  },
}
