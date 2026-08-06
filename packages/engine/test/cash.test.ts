import { describe, it, expect } from 'vitest'
import {
  applyCashFill,
  effectiveEntryRate,
  positionCostBasisInr,
  postedMarginInr,
  FLAT_CASH,
  type CashPosition,
} from '../src/cash'
import { isLiquidatable, liquidationPrice } from '../src/margin'

// Two clearly different rates, so a test that used the wrong one produces a
// visibly wrong number rather than a near-miss.
const RATE_BUY = 83
const RATE_SELL = 85

/** Open a position from flat. */
function open(qty: number, price: number, rate: number, leverage = 1) {
  return applyCashFill(FLAT_CASH, qty, price, rate, leverage)
}

/** Strip outcome-only fields back to a plain position. */
function pos(o: CashPosition): CashPosition {
  return { qty: o.qty, avgPrice: o.avgPrice, notionalBasisInr: o.notionalBasisInr, leverage: o.leverage }
}

// ---------------------------------------------------------------------------
// Decision 1 — leverage separates cash locked from P&L basis
// ---------------------------------------------------------------------------

describe('BUY locks basis; leverage divides the cash debit only', () => {
  it('at 1× debits the full notional, which is also the basis', () => {
    const p = open(10, 230, RATE_BUY, 1)

    expect(p.cashFlowInr).toBe(-190_900) // 10 × 230 × 83
    expect(p.notionalBasisInr).toBe(190_900)
    expect(p.marginPostedInr).toBe(190_900)
    expect(postedMarginInr(pos(p))).toBe(190_900)
    expect(p.realizedPnlInr).toBe(0)
  })

  it('at 5× debits notional ÷ 5 but keeps the FULL notional as basis', () => {
    const p = open(10, 230, RATE_BUY, 5)

    expect(p.cashFlowInr).toBe(-38_180) // 190,900 / 5 — the cash actually locked
    expect(p.notionalBasisInr).toBe(190_900) // undivided: P&L measures against this
    expect(p.marginPostedInr).toBe(38_180)
    expect(postedMarginInr(pos(p))).toBe(38_180)
    expect(p.leverage).toBe(5)
  })

  it('P&L is on full notional, so 5× earns 5× the return on cash committed', () => {
    const one = applyCashFill(pos(open(10, 230, RATE_BUY, 1)), -10, 240, RATE_BUY, 1)
    const five = applyCashFill(pos(open(10, 230, RATE_BUY, 5)), -10, 240, RATE_BUY, 5)

    // Identical rupee P&L — leverage does not change the P&L, only the outlay.
    expect(one.realizedPnlInr).toBe(8_300) // 10 × (240−230) × 83
    expect(five.realizedPnlInr).toBe(8_300)

    // ...but return on cash committed is 5× higher.
    const retOne = one.realizedPnlInr / 190_900
    const retFive = five.realizedPnlInr / 38_180
    expect(retFive / retOne).toBeCloseTo(5, 9)
  })

  it('an add posts margin at the position leverage and realizes nothing', () => {
    const one = open(10, 230, RATE_BUY, 5)
    const two = applyCashFill(pos(one), 10, 250, 90, 5)

    expect(two.realizedPnlInr).toBe(0)
    expect(two.closedQty).toBe(0)
    expect(two.notionalBasisInr).toBe(190_900 + 225_000) // 415,900 full notional
    expect(two.marginPostedInr).toBe(225_000 / 5) // 45,000
    expect(two.cashFlowInr).toBe(-45_000)
    expect(two.avgPrice).toBe(240) // (10×230 + 10×250)/20
    expect(two.leverage).toBe(5) // adds keep the position's leverage
  })

  it('reports the blended entry rate across adds at different rates', () => {
    const one = open(10, 230, RATE_BUY, 5)
    expect(effectiveEntryRate(one)).toBeCloseTo(83, 9)

    const two = applyCashFill(pos(one), 10, 250, 90, 5)
    expect(effectiveEntryRate(two)).toBeCloseTo(415_900 / (20 * 240), 9) // ≈86.6458
  })

  it('a zero-qty fill is a no-op', () => {
    expect(applyCashFill(FLAT_CASH, 0, 230, RATE_BUY, 5)).toMatchObject({
      qty: 0,
      cashFlowInr: 0,
      realizedPnlInr: 0,
      marginPostedInr: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// Holding — no settlement revaluation
// ---------------------------------------------------------------------------

describe('HOLDING never revalues for settlement', () => {
  it('takes no mark-price parameter at all', () => {
    expect(applyCashFill).toHaveLength(5) // (position, delta, price, rate, leverage)
  })

  it('leaves the position identical across no-op fills at any price or rate', () => {
    const held = pos(open(10, 230, RATE_BUY, 5))
    let cur = held
    for (const price of [1, 230, 500, 10_000]) {
      cur = pos(applyCashFill(cur, 0, price, price * 2, 5))
    }
    expect(cur).toEqual(held)
  })

  it('displays the fixed cost basis, not a valuation', () => {
    const held = pos(open(10, 230, RATE_BUY, 5))
    expect(positionCostBasisInr(held)).toBe(190_900)
    expect(held.avgPrice).toBe(230)
    expect(effectiveEntryRate(held)).toBe(83)
  })

  it('settles against the ORIGINAL basis even after a violent price move', () => {
    const held = pos(open(10, 230, RATE_BUY, 1))
    const out = applyCashFill(held, -10, 100, RATE_BUY, 1)
    expect(out.realizedPnlInr).toBeCloseTo(10 * 100 * 83 - 190_900, 9) // -107,900
  })
})

// ---------------------------------------------------------------------------
// Decision 2 — liquidation still works off the internal USD mark
// ---------------------------------------------------------------------------

describe('liquidation still works off the internal mark (decision 2)', () => {
  it('a cash-settled position still carries what margin.ts needs', () => {
    const p = pos(open(10, 230, RATE_BUY, 5))

    // avgPrice + leverage survive, so the USD liquidation math is unaffected.
    expect(liquidationPrice(p)).toBeCloseTo(230 * (1 - 1 / 5), 9) // 184
    expect(isLiquidatable(p, 185)).toBe(false)
    expect(isLiquidatable(p, 184)).toBe(true)
  })

  it('shorts liquidate symmetrically', () => {
    const s = pos(open(-10, 230, RATE_BUY, 5))
    expect(liquidationPrice(s)).toBeCloseTo(230 * (1 + 1 / 5), 9) // 276
    expect(isLiquidatable(s, 275)).toBe(false)
    expect(isLiquidatable(s, 276)).toBe(true)
  })

  it('liquidation price is rate-independent — it is a USD risk measure', () => {
    const atLowRate = pos(open(10, 230, 70, 5))
    const atHighRate = pos(open(10, 230, 95, 5))
    expect(liquidationPrice(atLowRate)).toBe(liquidationPrice(atHighRate))
  })
})

// ---------------------------------------------------------------------------
// SELL settles at the sell-time rate
// ---------------------------------------------------------------------------

describe('SELL settles at the SELL-TIME rate', () => {
  it('returns margin plus P&L, and at 1× that equals the full sale proceeds', () => {
    const held = pos(open(10, 230, RATE_BUY, 1))
    const out = applyCashFill(held, -10, 240, RATE_SELL, 1)

    expect(out.marginReleasedInr).toBe(190_900)
    expect(out.realizedPnlInr).toBe(13_100) // 204,000 − 190,900
    expect(out.cashFlowInr).toBe(204_000) // = 10 × 240 × 85
    expect(out.qty).toBe(0)
    expect(out.notionalBasisInr).toBe(0)
    expect(out.closedQty).toBe(10)
  })

  it('at 5× returns only the posted margin plus the full P&L', () => {
    const held = pos(open(10, 230, RATE_BUY, 5))
    const out = applyCashFill(held, -10, 240, RATE_SELL, 5)

    expect(out.marginReleasedInr).toBe(38_180)
    expect(out.realizedPnlInr).toBe(13_100) // same rupee P&L as 1×
    expect(out.cashFlowInr).toBe(51_280) // 38,180 + 13,100
  })

  it('realizes P&L from a pure FX move at an UNCHANGED USD price', () => {
    const held = pos(open(10, 230, RATE_BUY, 1))
    // Buy-time rate would give exactly 0, so this fails loudly if the wrong
    // rate is used.
    const out = applyCashFill(held, -10, 230, RATE_SELL, 1)

    expect(out.realizedPnlInr).toBe(4_600) // 10 × 230 × (85−83)
    expect(out.cashFlowInr).toBe(195_500)
  })

  it('realizes an FX loss when the rate falls', () => {
    const held = pos(open(10, 230, RATE_BUY, 1))
    const out = applyCashFill(held, -10, 230, 80, 1)
    expect(out.realizedPnlInr).toBe(-6_900) // 10 × 230 × (80−83)
  })

  it('decomposes price and rate effects additively plus the cross term', () => {
    const held = pos(open(10, 230, RATE_BUY, 1))
    const priceOnly = applyCashFill(held, -10, 240, RATE_BUY, 1)
    const rateOnly = applyCashFill(held, -10, 230, RATE_SELL, 1)
    const both = applyCashFill(held, -10, 240, RATE_SELL, 1)

    expect(priceOnly.realizedPnlInr).toBe(8_300)
    expect(rateOnly.realizedPnlInr).toBe(4_600)
    expect(both.realizedPnlInr).toBe(13_100)
    expect(both.realizedPnlInr).toBe(priceOnly.realizedPnlInr + rateOnly.realizedPnlInr + 200)
  })

  it('net cash over a round trip equals realized P&L, at any leverage', () => {
    for (const L of [1, 2, 5]) {
      const entry = open(10, 230, RATE_BUY, L)
      const exit = applyCashFill(pos(entry), -10, 240, RATE_SELL, L)
      expect(entry.cashFlowInr + exit.cashFlowInr).toBeCloseTo(exit.realizedPnlInr, 6)
      expect(exit.realizedPnlInr).toBeCloseTo(13_100, 6)
    }
  })
})

// ---------------------------------------------------------------------------
// Partial reduces
// ---------------------------------------------------------------------------

describe('PARTIAL reduces realize proportionally', () => {
  it('releases basis and margin pro rata, holding the per-unit basis', () => {
    const held = pos(open(10, 230, RATE_BUY, 1)) // 19,090 / unit
    const out = applyCashFill(held, -4, 240, RATE_SELL, 1)

    expect(out.realizedPnlInr).toBe(5_240) // (20,400 − 19,090) × 4
    expect(out.marginReleasedInr).toBe(76_360) // 19,090 × 4 / 1
    expect(out.cashFlowInr).toBe(81_600) // = 4 × 240 × 85
    expect(out.qty).toBe(6)
    expect(out.avgPrice).toBe(230) // entry price untouched
    expect(out.notionalBasisInr).toBe(114_540) // 19,090 × 6
    expect(out.closedQty).toBe(4)
  })

  it('releases margin pro rata at 5× too', () => {
    const held = pos(open(10, 230, RATE_BUY, 5)) // margin 38,180
    const out = applyCashFill(held, -4, 240, RATE_SELL, 5)

    expect(out.marginReleasedInr).toBeCloseTo(15_272, 9) // 76,360 / 5
    expect(out.realizedPnlInr).toBe(5_240) // unchanged by leverage
    expect(out.cashFlowInr).toBeCloseTo(20_512, 9)
    expect(postedMarginInr(pos(out))).toBeCloseTo(22_908, 9) // 38,180 − 15,272
  })

  it('the remainder keeps the ORIGINAL entry rate, not the sell rate', () => {
    const after = pos(applyCashFill(pos(open(10, 230, RATE_BUY, 1)), -4, 240, RATE_SELL, 1))
    expect(effectiveEntryRate(after)).toBeCloseTo(83, 9)
  })

  it('totals the same whether closed in one sale or several', () => {
    const held = pos(open(10, 230, RATE_BUY, 5))
    const oneShot = applyCashFill(held, -10, 240, RATE_SELL, 5)

    const a = applyCashFill(held, -3, 240, RATE_SELL, 5)
    const b = applyCashFill(pos(a), -3, 240, RATE_SELL, 5)
    const c = applyCashFill(pos(b), -4, 240, RATE_SELL, 5)

    expect(a.realizedPnlInr + b.realizedPnlInr + c.realizedPnlInr).toBeCloseTo(oneShot.realizedPnlInr, 6)
    expect(c.qty).toBe(0)
    expect(c.notionalBasisInr).toBe(0)
  })

  it('each tranche settles at its own rate', () => {
    const held = pos(open(10, 230, RATE_BUY, 1))
    const a = applyCashFill(held, -4, 240, 85, 1)
    const b = applyCashFill(pos(a), -6, 250, 90, 1)

    expect(a.realizedPnlInr).toBe(5_240)
    expect(b.realizedPnlInr).toBe(20_460) // (22,500 − 19,090) × 6
    expect(-190_900 + a.cashFlowInr + b.cashFlowInr).toBeCloseTo(25_700, 6)
  })

  it('cash conservation holds across a build-up-then-unwind at 5×', () => {
    const s1 = open(10, 230, 83, 5)
    const s2 = applyCashFill(pos(s1), 10, 250, 90, 5)
    const s3 = applyCashFill(pos(s2), -5, 260, 88, 5)
    const s4 = applyCashFill(pos(s3), -15, 240, 86, 5)

    expect(s4.qty).toBe(0)
    expect(s4.notionalBasisInr).toBe(0)

    const cash = s1.cashFlowInr + s2.cashFlowInr + s3.cashFlowInr + s4.cashFlowInr
    const realized = s1.realizedPnlInr + s2.realizedPnlInr + s3.realizedPnlInr + s4.realizedPnlInr
    expect(cash).toBeCloseTo(realized, 6)
  })
})

// ---------------------------------------------------------------------------
// Decision 3 — a short open must NOT credit spendable cash
// ---------------------------------------------------------------------------

describe('SHORTS post margin and never credit spendable cash (decision 3)', () => {
  it('opening a short DEBITS margin rather than crediting the proceeds', () => {
    const p = open(-10, 230, RATE_BUY, 1)

    // The critical assertion: negative cash flow on a short open.
    expect(p.cashFlowInr).toBeLessThan(0)
    expect(p.cashFlowInr).toBe(-190_900) // margin posted, not +190,900 proceeds
    expect(p.marginPostedInr).toBe(190_900)
    expect(p.notionalBasisInr).toBe(-190_900) // signed like qty
    expect(p.qty).toBe(-10)
  })

  it('a levered short posts notional ÷ leverage, still a debit', () => {
    const p = open(-10, 230, RATE_BUY, 5)
    expect(p.cashFlowInr).toBe(-38_180)
    expect(p.marginPostedInr).toBe(38_180)
    expect(postedMarginInr(pos(p))).toBe(38_180)
  })

  it('shorting cannot fund additional buying power at any leverage', () => {
    for (const L of [1, 2, 5]) {
      for (const qty of [-1, -10, -250]) {
        expect(open(qty, 230, RATE_BUY, L).cashFlowInr).toBeLessThan(0)
      }
    }
  })

  it('adding to a short also debits', () => {
    const s1 = open(-10, 230, RATE_BUY, 5)
    const s2 = applyCashFill(pos(s1), -5, 240, 84, 5)

    expect(s2.cashFlowInr).toBeLessThan(0)
    expect(s2.cashFlowInr).toBeCloseTo(-(5 * 240 * 84) / 5, 9) // -20,160
    expect(s2.qty).toBe(-15)
    expect(s2.realizedPnlInr).toBe(0)
  })

  it('reports a positive per-unit basis and unsigned cost basis for display', () => {
    const p = open(-10, 230, RATE_BUY, 1)
    expect(effectiveEntryRate(p)).toBeCloseTo(83, 9)
    expect(positionCostBasisInr(p)).toBe(190_900)
  })

  it('buying back cheaper realizes a gain and returns the margin', () => {
    const short = pos(open(-10, 230, RATE_BUY, 1))
    const out = applyCashFill(short, 10, 220, RATE_BUY, 1)

    expect(out.realizedPnlInr).toBe(8_300) // (19,090 − 18,260) × 10
    expect(out.marginReleasedInr).toBe(190_900)
    expect(out.cashFlowInr).toBe(199_200) // margin back + P&L
    expect(out.qty).toBe(0)
  })

  it('buying back dearer realizes a loss', () => {
    const short = pos(open(-10, 230, RATE_BUY, 1))
    const out = applyCashFill(short, 10, 245, RATE_BUY, 1)
    expect(out.realizedPnlInr).toBeCloseTo(-12_450, 9)
  })

  it('a short round trip nets to realized P&L, at any leverage', () => {
    for (const L of [1, 2, 5]) {
      const entry = open(-10, 230, RATE_BUY, L)
      const exit = applyCashFill(pos(entry), 10, 220, RATE_BUY, L)
      expect(entry.cashFlowInr + exit.cashFlowInr).toBeCloseTo(exit.realizedPnlInr, 6)
      expect(exit.realizedPnlInr).toBeCloseTo(8_300, 6)
    }
  })

  it('a partial buy-back releases basis and margin pro rata', () => {
    const short = pos(open(-10, 230, RATE_BUY, 5))
    const out = applyCashFill(short, 4, 220, RATE_BUY, 5)

    expect(out.qty).toBe(-6)
    expect(out.notionalBasisInr).toBeCloseTo(-114_540, 9)
    expect(out.realizedPnlInr).toBeCloseTo(3_320, 9) // (19,090 − 18,260) × 4
    expect(out.marginReleasedInr).toBeCloseTo(76_360 / 5, 9)
    expect(out.avgPrice).toBe(230)
  })

  it('a short also realizes FX: rate UP is a loss on a short', () => {
    const short = pos(open(-10, 230, RATE_BUY, 1))
    const out = applyCashFill(short, 10, 230, RATE_SELL, 1) // same USD price, rate 83→85
    expect(out.realizedPnlInr).toBe(-4_600)
  })
})

// ---------------------------------------------------------------------------
// Flips
// ---------------------------------------------------------------------------

describe('FLIPS realize the old side and post fresh margin on the residual', () => {
  it('nets released margin against the new margin posted', () => {
    const held = pos(open(10, 230, RATE_BUY, 1))
    const out = applyCashFill(held, -15, 240, RATE_SELL, 1) // close 10 long, open 5 short

    expect(out.closedQty).toBe(10)
    expect(out.realizedPnlInr).toBe(13_100)
    expect(out.marginReleasedInr).toBe(190_900)
    expect(out.marginPostedInr).toBe(5 * 240 * 85) // 102,000 residual short margin
    expect(out.cashFlowInr).toBe(190_900 + 13_100 - 102_000)
    expect(out.qty).toBe(-5)
    expect(out.avgPrice).toBe(240)
    expect(out.notionalBasisInr).toBe(-102_000) // at the NEW rate
  })

  it('the residual takes the fill leverage', () => {
    const out = applyCashFill(pos(open(10, 230, RATE_BUY, 1)), -15, 240, RATE_SELL, 3)
    expect(out.leverage).toBe(3)
    expect(out.marginPostedInr).toBeCloseTo(102_000 / 3, 9)
  })

  it('the residual then settles against its own basis and rate', () => {
    const flipped = pos(applyCashFill(pos(open(10, 230, RATE_BUY, 1)), -15, 240, RATE_SELL, 1))
    expect(effectiveEntryRate(flipped)).toBeCloseTo(85, 9)

    const closed = applyCashFill(flipped, 5, 230, RATE_SELL, 1)
    expect(closed.realizedPnlInr).toBeCloseTo(5 * (240 - 230) * 85, 9) // 4,250
    expect(closed.qty).toBe(0)
  })

  it('cash still conserves across a flip and final close', () => {
    const s1 = open(10, 230, 83, 1)
    const s2 = applyCashFill(pos(s1), -15, 240, 85, 1)
    const s3 = applyCashFill(pos(s2), 5, 230, 85, 1)

    expect(s3.qty).toBe(0)
    const cash = s1.cashFlowInr + s2.cashFlowInr + s3.cashFlowInr
    const realized = s1.realizedPnlInr + s2.realizedPnlInr + s3.realizedPnlInr
    expect(cash).toBeCloseTo(realized, 6)
  })
})

// ---------------------------------------------------------------------------
// Helpers / edges
// ---------------------------------------------------------------------------

describe('helpers and edges', () => {
  it('flat reports null rate, zero basis, zero margin', () => {
    expect(effectiveEntryRate(FLAT_CASH)).toBeNull()
    expect(positionCostBasisInr(FLAT_CASH)).toBe(0)
    expect(postedMarginInr(FLAT_CASH)).toBe(0)
  })

  it('FLAT_CASH is not mutated by use', () => {
    applyCashFill(FLAT_CASH, 10, 230, RATE_BUY, 5)
    expect(FLAT_CASH).toEqual({ qty: 0, avgPrice: 0, notionalBasisInr: 0, leverage: 1 })
  })

  it('guards a non-positive leverage in postedMarginInr', () => {
    expect(postedMarginInr({ qty: 10, avgPrice: 230, notionalBasisInr: 190_900, leverage: 0 })).toBe(0)
  })
})
