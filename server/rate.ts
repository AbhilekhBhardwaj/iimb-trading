/**
 * Live USD→INR rate — the single source of truth for currency conversion.
 *
 * Starts at the base rate and, once drift is started (only by the API server),
 * does a gentle bounded random walk so the frontend shows a moving "current
 * rate" rather than a hardcoded constant. Tests/smoke scripts never call
 * startRateDrift(), so they see a fixed, deterministic base rate.
 */
import { USD_INR as BASE_RATE } from './config'

let current = BASE_RATE
let timer: ReturnType<typeof setInterval> | null = null

/** The current USD→INR rate (INR per 1 USD). */
export function usdInr(): number {
  return current
}

/** Begin the ±~0.75%-every-3s bounded drift. Idempotent; API-server only. */
export function startRateDrift(): void {
  if (timer) return
  const low = BASE_RATE * 0.94
  const high = BASE_RATE * 1.06
  timer = setInterval(() => {
    const step = (Math.random() * 2 - 1) * 0.0075 // ±0.75%
    current = Math.min(high, Math.max(low, current * (1 + step)))
  }, 3000)
  // Don't keep the process alive just for the drift timer.
  ;(timer as { unref?: () => void }).unref?.()
}
