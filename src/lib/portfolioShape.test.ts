/**
 * The Portfolio payload's array fields must BE arrays by the time any component
 * touches them.
 *
 * `get<Portfolio>` finishes with `as T`, a compile-time cast with no runtime
 * check, so the type system's guarantee that `workingOrders` exists is worth
 * nothing against a real response. A server running a build older than the
 * field returns JSON without it and the page dies on `.length` before rendering
 * anything — a blank screen, not a degraded section.
 */
import { describe, expect, it } from 'vitest'
import { normalizePortfolio, type Portfolio } from './api'

/** A complete, current-server response. */
const full: Portfolio = {
  rate: 83,
  commissionEnabled: true,
  commissionRate: 0.003,
  slippageEnabled: true,
  workingOrders: [
    { orderId: 'o1', ticker: 'AAPL', side: 'buy', type: 'limit', price: 190, qty: 10, remainingQty: 6, status: 'partially_filled', leverage: 1, placedAt: 1 },
  ],
  openingBalanceInr: 1_000_000,
  realizedPnlInr: -30_026,
  cashInr: 111_079,
  inventory: [],
  marginUsedInr: 106_875,
  marginReservedInr: 752_020,
  totalPnlInr: -30_026,
  totalPnlPct: -3.0026,
  totalPortfolioValueInr: 969_974,
  xirr: null,
  leverageReq: 1,
  openPositions: 1,
  chargesInr: 2521,
  tradeHistory: [],
}

/** What an older server sends: no `workingOrders` key at all. */
const legacy = (() => {
  const p = { ...full } as Partial<Portfolio>
  delete p.workingOrders
  return p as Portfolio
})()

describe('an account with NO working orders', () => {
  it('renders from an empty array rather than crashing', () => {
    const p = normalizePortfolio({ ...full, workingOrders: [] })
    expect(p.workingOrders).toEqual([])
    expect(p.workingOrders.length).toBe(0)
  })

  it('survives the field being omitted entirely by an older server', () => {
    expect(legacy.workingOrders).toBeUndefined() // the exact crash condition
    const p = normalizePortfolio(legacy)
    expect(p.workingOrders).toEqual([])
    expect(() => p.workingOrders.length).not.toThrow()
    expect(() => p.workingOrders.map((o) => o.orderId)).not.toThrow()
  })
})

describe('an account WITH working orders', () => {
  it('passes them through untouched', () => {
    const p = normalizePortfolio(full)
    expect(p.workingOrders).toHaveLength(1)
    expect(p.workingOrders[0].orderId).toBe('o1')
    expect(p.workingOrders[0].remainingQty).toBe(6)
  })

  it('leaves every other field exactly as the server sent it', () => {
    const p = normalizePortfolio(full)
    expect(p.totalPortfolioValueInr).toBe(969_974)
    expect(p.marginReservedInr).toBe(752_020)
    expect(p.cashInr).toBe(111_079)
    expect(p.xirr).toBeNull()
  })

  it('is a no-op on an already-valid payload', () => {
    expect(normalizePortfolio(full)).toEqual(full)
  })
})

describe('the other two arrays read the same way, so they get the same guarantee', () => {
  it('inventory — read at the top of the component, before anything renders', () => {
    const p = normalizePortfolio({ ...full, inventory: undefined as never })
    expect(p.inventory).toEqual([])
    expect(() => p.inventory.filter((r) => r.qty != null)).not.toThrow()
  })

  it('tradeHistory', () => {
    const p = normalizePortfolio({ ...full, tradeHistory: undefined as never })
    expect(p.tradeHistory).toEqual([])
  })

  it('all three missing at once still yields a renderable payload', () => {
    const bare = { ...full, inventory: undefined, workingOrders: undefined, tradeHistory: undefined } as unknown as Portfolio
    const p = normalizePortfolio(bare)
    expect(p.inventory).toEqual([])
    expect(p.workingOrders).toEqual([])
    expect(p.tradeHistory).toEqual([])
  })
})

describe('malformed values, not just missing ones', () => {
  it('null becomes an empty array', () => {
    const p = normalizePortfolio({ ...full, workingOrders: null as never })
    expect(p.workingOrders).toEqual([])
  })

  it('a non-array becomes an empty array rather than crashing on .map', () => {
    for (const junk of ['', 0, {}, 'nope']) {
      const p = normalizePortfolio({ ...full, workingOrders: junk as never })
      expect(Array.isArray(p.workingOrders)).toBe(true)
      expect(() => p.workingOrders.map((o) => o.orderId)).not.toThrow()
    }
  })
})
