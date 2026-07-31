/**
 * XIRR — internal rate of return for irregularly-timed cash flows.
 *
 * Pure and deterministic (no clock/RNG/I/O), like the rest of the engine.
 * Solves for the annualized rate r such that the net present value of the flows
 * is zero:  Σ amountᵢ / (1 + r)^(yearsᵢ) = 0,  yearsᵢ = (dateᵢ − date₀) / 365 days.
 *
 * Newton–Raphson from a starting guess, with a robust bisection fallback so it
 * still converges when Newton diverges (common for high/volatile returns).
 */

export interface CashFlow {
  /** Positive = inflow (money received), negative = outflow (money invested). */
  amount: number
  /** Epoch milliseconds. */
  when: number
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000

function npv(rate: number, flows: CashFlow[], t0: number): number {
  let sum = 0
  for (const f of flows) {
    const years = (f.when - t0) / MS_PER_YEAR
    sum += f.amount / Math.pow(1 + rate, years)
  }
  return sum
}

function npvDerivative(rate: number, flows: CashFlow[], t0: number): number {
  let sum = 0
  for (const f of flows) {
    const years = (f.when - t0) / MS_PER_YEAR
    if (years === 0) continue
    sum += (-years * f.amount) / Math.pow(1 + rate, years + 1)
  }
  return sum
}

/**
 * Annualized IRR of the flows as a decimal (0.1 = 10%), or null when it can't be
 * solved (fewer than 2 flows, all same sign, or no sign change can be bracketed
 * — e.g. a gain over a period so short the annualized rate is effectively
 * unbounded). `guess` seeds Newton's method.
 */
export function xirr(flows: CashFlow[], guess = 0.1): number | null {
  if (flows.length < 2) return null
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null

  const t0 = Math.min(...flows.map((f) => f.when))

  // --- Newton–Raphson ---
  let rate = guess
  for (let i = 0; i < 100; i++) {
    const value = npv(rate, flows, t0)
    if (Math.abs(value) < 1e-8) return rate
    const deriv = npvDerivative(rate, flows, t0)
    if (deriv === 0 || !Number.isFinite(deriv)) break
    let next = rate - value / deriv
    if (!Number.isFinite(next)) break
    if (next <= -0.9999999) next = (rate - 0.9999999) / 2 // keep (1 + r) > 0
    if (Math.abs(next - rate) < 1e-12) return next
    rate = next
  }

  // --- Bisection fallback over a wide bracket ---
  let lo = -0.9999999
  let hi = 1e7
  let flo = npv(lo, flows, t0)
  let fhi = npv(hi, flows, t0)
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) {
    return null // cannot bracket a root
  }
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2
    const fmid = npv(mid, flows, t0)
    if (Math.abs(fmid) < 1e-9 || (hi - lo) / 2 < 1e-12) return mid
    if (Math.sign(fmid) === Math.sign(flo)) {
      lo = mid
      flo = fmid
    } else {
      hi = mid
      fhi = fmid
    }
  }
  return (lo + hi) / 2
}
