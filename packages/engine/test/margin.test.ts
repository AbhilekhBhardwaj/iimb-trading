import { describe, it, expect } from 'vitest'
import {
  applyLeveredFill,
  isLiquidatable,
  liquidationPrice,
  positionMargin,
  requiredMargin,
  type LeveredPosition,
} from '../src/margin'

const flat = (leverage = 1): LeveredPosition => ({ qty: 0, avgPrice: 0, leverage })

describe('positionMargin', () => {
  it('is notional / leverage, and 0 when flat', () => {
    expect(positionMargin(100, 100, 5)).toBe(2000)
    expect(positionMargin(-100, 100, 5)).toBe(2000) // shorts post margin too
    expect(positionMargin(0, 0, 5)).toBe(0)
    expect(positionMargin(50, 200, 1)).toBe(10000)
  })
})

describe('applyLeveredFill — open / add / reduce / close / flip', () => {
  it('opens from flat at the fill price and the order leverage', () => {
    const r = applyLeveredFill(flat(), 50, 100, 5)
    expect(r).toMatchObject({ qty: 50, avgPrice: 100, leverage: 5, realizedPnl: 0 })
  })

  it('adds in the same direction with a quantity-weighted average, no realized P&L', () => {
    // long 50 @ 100, buy 50 @ 110 -> 100 @ 105
    const r = applyLeveredFill({ qty: 50, avgPrice: 100, leverage: 5 }, 50, 110, 5)
    expect(r.qty).toBe(100)
    expect(r.avgPrice).toBeCloseTo(105, 9)
    expect(r.leverage).toBe(5) // add keeps the position's leverage
    expect(r.realizedPnl).toBe(0)
  })

  it('adds to a short symmetrically (avg stays positive)', () => {
    const r = applyLeveredFill({ qty: -50, avgPrice: 100, leverage: 3 }, -50, 110, 10)
    expect(r.qty).toBe(-100)
    expect(r.avgPrice).toBeCloseTo(105, 9)
    expect(r.leverage).toBe(3)
  })

  it('reduces with avg held and realizes P&L on the closed amount (long)', () => {
    // long 100 @ 105, sell 60 @ 120 -> long 40 @ 105, realize 60*(120-105)=+900
    const r = applyLeveredFill({ qty: 100, avgPrice: 105, leverage: 5 }, -60, 120, 5)
    expect(r.qty).toBe(40)
    expect(r.avgPrice).toBeCloseTo(105, 9)
    expect(r.realizedPnl).toBeCloseTo(900, 9)
  })

  it('realizes P&L correctly when reducing a short', () => {
    // short 100 @ 105, buy 40 @ 100 -> short 60 @ 105, realize 40*(105-100)=+200
    const r = applyLeveredFill({ qty: -100, avgPrice: 105, leverage: 5 }, 40, 100, 5)
    expect(r.qty).toBe(-60)
    expect(r.avgPrice).toBeCloseTo(105, 9)
    expect(r.realizedPnl).toBeCloseTo(200, 9)
  })

  it('closes exactly to flat, resetting the average', () => {
    const r = applyLeveredFill({ qty: 40, avgPrice: 105, leverage: 5 }, -40, 130, 5)
    expect(r).toMatchObject({ qty: 0, avgPrice: 0 })
    expect(r.realizedPnl).toBeCloseTo(40 * (130 - 105), 9)
  })

  it('flips past zero: realizes the whole old side, residual opens at fill price + order leverage', () => {
    // long 40 @ 105, sell 100 @ 130 -> short 60. realize 40*(130-105)=+1000
    const r = applyLeveredFill({ qty: 40, avgPrice: 105, leverage: 5 }, -100, 130, 3)
    expect(r.qty).toBe(-60)
    expect(r.avgPrice).toBeCloseTo(130, 9)
    expect(r.leverage).toBe(3) // flip adopts the order's leverage
    expect(r.realizedPnl).toBeCloseTo(1000, 9)
  })
})

describe('requiredMargin — scales with total resulting position', () => {
  it('charges full notional/leverage to open', () => {
    expect(requiredMargin(flat(), 50, 100, 5)).toBeCloseTo((50 * 100) / 5, 9) // 1000
  })

  it('charges only the incremental margin to add, using the position leverage', () => {
    // already long 50 @ 100 (lev 5, margin 1000). Adding 50 @ 110 needs 50*110/5 = 1100.
    const existing: LeveredPosition = { qty: 50, avgPrice: 100, leverage: 5 }
    expect(requiredMargin(existing, 50, 110, 5)).toBeCloseTo(1100, 9)
    // ...and total posted margin afterwards is before + required.
    const before = positionMargin(50, 100, 5)
    const afterQty = applyLeveredFill(existing, 50, 110, 5)
    expect(positionMargin(afterQty.qty, afterQty.avgPrice, afterQty.leverage)).toBeCloseTo(
      before + 1100,
      9,
    )
  })

  it('returns <= 0 for a reduce (frees margin)', () => {
    const existing: LeveredPosition = { qty: 100, avgPrice: 105, leverage: 5 }
    expect(requiredMargin(existing, -60, 120, 5)).toBeLessThan(0)
  })

  it('nets freed vs opened margin on a flip', () => {
    // long 40 @ 105 lev5 (margin 840) -> flip to short 60 @ 130 lev5 (margin 1560).
    const existing: LeveredPosition = { qty: 40, avgPrice: 105, leverage: 5 }
    const req = requiredMargin(existing, -100, 130, 5)
    expect(req).toBeCloseTo((60 * 130) / 5 - (40 * 105) / 5, 9) // 1560 - 840 = 720
  })
})

describe('liquidationPrice & isLiquidatable', () => {
  it('long liquidates below entry by 1/leverage (no maintenance)', () => {
    expect(liquidationPrice({ qty: 10, avgPrice: 100, leverage: 5 })).toBeCloseTo(80, 9)
    expect(liquidationPrice({ qty: 10, avgPrice: 100, leverage: 2 })).toBeCloseTo(50, 9)
  })

  it('short liquidates above entry by 1/leverage', () => {
    expect(liquidationPrice({ qty: -10, avgPrice: 100, leverage: 5 })).toBeCloseTo(120, 9)
    expect(liquidationPrice({ qty: -10, avgPrice: 100, leverage: 4 })).toBeCloseTo(125, 9)
  })

  it('1x long can only be wiped at zero; 1x short at 2x entry', () => {
    expect(liquidationPrice({ qty: 5, avgPrice: 200, leverage: 1 })).toBeCloseTo(0, 9)
    expect(liquidationPrice({ qty: -5, avgPrice: 200, leverage: 1 })).toBeCloseTo(400, 9)
  })

  it('a maintenance-margin buffer liquidates earlier', () => {
    // 5x long, mmr 5%: E*(1-0.2)/(1-0.05) = 80/0.95 ≈ 84.21 > 80 (liquidates sooner).
    expect(liquidationPrice({ qty: 10, avgPrice: 100, leverage: 5 }, 0.05)).toBeCloseTo(84.2105, 3)
  })

  it('returns null / not-liquidatable when flat', () => {
    expect(liquidationPrice({ qty: 0, avgPrice: 0, leverage: 5 })).toBeNull()
    expect(isLiquidatable({ qty: 0, avgPrice: 0, leverage: 5 }, 1)).toBe(false)
  })

  it('detects liquidation at or beyond the liquidation price', () => {
    const long: LeveredPosition = { qty: 100, avgPrice: 100, leverage: 5 } // liq 80
    expect(isLiquidatable(long, 81)).toBe(false)
    expect(isLiquidatable(long, 80)).toBe(true) // at the line
    expect(isLiquidatable(long, 79)).toBe(true)

    const short: LeveredPosition = { qty: -100, avgPrice: 100, leverage: 5 } // liq 120
    expect(isLiquidatable(short, 119)).toBe(false)
    expect(isLiquidatable(short, 121)).toBe(true)
  })
})
