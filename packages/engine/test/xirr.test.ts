import { describe, it, expect } from 'vitest'
import { xirr, type CashFlow } from '../src/xirr'

/** Build a cash flow from an ISO date + amount. */
const cf = (date: string, amount: number): CashFlow => ({ amount, when: Date.parse(date) })

describe('xirr', () => {
  // Dates chosen on non-leap-year spans so a "year" is exactly 365 days,
  // matching the actual/365 day-count XIRR uses (2021 and 2022 are not leap years).
  it('a simple one-year 10% return', () => {
    const r = xirr([cf('2021-01-01', -1000), cf('2022-01-01', 1100)])
    expect(r).toBeCloseTo(0.1, 4)
  })

  it('a one-year 50% gain and a one-year 10% loss', () => {
    expect(xirr([cf('2021-01-01', -100), cf('2022-01-01', 150)])).toBeCloseTo(0.5, 4)
    expect(xirr([cf('2021-01-01', -1000), cf('2022-01-01', 900)])).toBeCloseTo(-0.1, 4)
  })

  it('compounds correctly over two years: (1.2)^(1/2) − 1 ≈ 9.5445%', () => {
    const r = xirr([cf('2021-01-01', -1000), cf('2023-01-01', 1200)]) // 730 days = 2×365
    expect(r).toBeCloseTo(Math.sqrt(1.2) - 1, 4) // ≈ 0.0954451
  })

  it('matches the canonical Excel XIRR example (≈ 37.34%)', () => {
    // Straight from Microsoft's XIRR documentation example.
    const flows = [
      cf('2008-01-01', -10000),
      cf('2008-03-01', 2750),
      cf('2008-10-30', 4250),
      cf('2009-02-15', 3250),
      cf('2009-04-01', 2750),
    ]
    expect(xirr(flows)).toBeCloseTo(0.373362535, 5)
  })

  it('handles multiple outflows then a payoff', () => {
    // Two investments, one payout. NPV at the returned rate must be ~0.
    const flows = [cf('2021-01-01', -1000), cf('2021-07-01', -500), cf('2022-01-01', 1650)]
    const r = xirr(flows)!
    const t0 = Math.min(...flows.map((f) => f.when))
    const check = flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.when - t0) / (365 * 864e5)), 0)
    expect(check).toBeCloseTo(0, 3)
  })

  it('converges for a large short-horizon return (Newton would diverge)', () => {
    // +25% in a month → very high annualized rate; must still solve, NPV ~ 0.
    const flows = [cf('2024-01-01', -1000), cf('2024-02-01', 1250)]
    const r = xirr(flows)!
    expect(r).toBeGreaterThan(1) // well over 100% annualized
    const t0 = flows[0].when
    const check = flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.when - t0) / (365 * 864e5)), 0)
    expect(check).toBeCloseTo(0, 3)
  })

  it('returns null when it cannot be solved', () => {
    expect(xirr([])).toBeNull()
    expect(xirr([cf('2020-01-01', -1000)])).toBeNull() // single flow
    expect(xirr([cf('2020-01-01', -1000), cf('2021-01-01', -500)])).toBeNull() // all outflows
    expect(xirr([cf('2020-01-01', 1000), cf('2021-01-01', 500)])).toBeNull() // all inflows
  })
})
