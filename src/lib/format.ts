/**
 * Money and percentage formatters.
 *
 * Split out of simulation.ts, which also exports a React hook that touches
 * `window` — importing a formatter from there dragged the whole browser module
 * in, so pure logic (orderConfirm, slippage) could not be used or tested outside
 * a DOM environment. Nothing here touches React, the DOM, or a clock.
 *
 * simulation.ts re-exports these, so existing `from './simulation'` imports keep
 * working and there is still one definition of each.
 */

const inrFmt0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** Indian-grouped rupee string (e.g. ₹10,24,500). */
export function inr(v: number): string {
  return inrFmt0.format(v)
}

/** Signed rupee string for P&L (e.g. +₹12,340 / −₹4,120). */
export function inrSigned(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${inrFmt0.format(Math.abs(v))}`
}

/** USD price string (e.g. $128.40). */
export function usd(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Compact USD for axis ticks (e.g. $2,648 / $71.2). */
export function usdAxis(v: number): string {
  return v >= 100
    ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${v.toFixed(1)}`
}

/** Signed percent string (e.g. +2.41% / −1.08%). */
export function pct(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${Math.abs(v).toFixed(2)}%`
}
