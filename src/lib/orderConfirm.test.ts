import { type CashPosition, FLAT_CASH } from '@iimb-trading/engine'
import { describe, expect, it } from 'vitest'
import { orderPnlLines, pnlBreakdownLines, toCashPosition } from './orderConfirm'

const RATE = 83

/** Long 10 @ $180, basis ₹149,400. */
const LONG: CashPosition = { qty: 10, avgPrice: 180, notionalBasisInr: 149_400, leverage: 1 }
/** Short 10 @ $180, basis −₹149,400. */
const SHORT: CashPosition = { qty: -10, avgPrice: 180, notionalBasisInr: -149_400, leverage: 1 }

const keys = (lines: { k: string }[]) => lines.map((l) => l.k)
const valueOf = (lines: { k: string; v: string }[], k: string) => lines.find((l) => l.k === k)?.v

describe('closing fill, commission ON', () => {
  const lines = orderPnlLines(LONG, -10, 190, RATE, 1, true)

  it('shows all three lines, in order', () => {
    expect(keys(lines)).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
  })

  it('shows the correct gross, commission and net', () => {
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹8,300')
    expect(valueOf(lines, 'Commission')).toBe('−₹473') // 0.003 × 10 × 190 × 83 = 473.10
    expect(valueOf(lines, 'Net P&L')).toBe('+₹7,827') // 8,300 − 473.10
  })

  it('renders commission as a charge, never as a gain', () => {
    const commission = lines.find((l) => l.k === 'Commission')!
    expect(commission.v.startsWith('−')).toBe(true)
    expect(commission.tone).toBe('destructive')
  })

  it('tones a profitable gross and net green', () => {
    expect(lines.find((l) => l.k === 'Gross P&L')!.tone).toBe('up')
    expect(lines.find((l) => l.k === 'Net P&L')!.tone).toBe('up')
  })

  it('tones a losing close red on both gross and net', () => {
    const losing = orderPnlLines(LONG, -10, 170, RATE, 1, true)
    expect(valueOf(losing, 'Gross P&L')).toBe('−₹8,300')
    expect(valueOf(losing, 'Net P&L')).toBe('−₹8,723') // loss deepened by ₹423.30
    expect(losing.find((l) => l.k === 'Gross P&L')!.tone).toBe('destructive')
    expect(losing.find((l) => l.k === 'Net P&L')!.tone).toBe('destructive')
  })

  it('shows the breakdown for a partial reduce', () => {
    const partial = orderPnlLines(LONG, -4, 190, RATE, 1, true)
    expect(keys(partial)).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
    expect(valueOf(partial, 'Gross P&L')).toBe('+₹3,320')
    expect(valueOf(partial, 'Commission')).toBe('−₹189')
    expect(valueOf(partial, 'Net P&L')).toBe('+₹3,131')
  })

  it('shows the breakdown when a BUY closes a short', () => {
    const covering = orderPnlLines(SHORT, 10, 170, RATE, 1, true)
    expect(keys(covering)).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
    expect(valueOf(covering, 'Gross P&L')).toBe('+₹8,300')
    expect(valueOf(covering, 'Net P&L')).toBe('+₹7,877')
  })
})

describe('closing fill, commission OFF', () => {
  const lines = orderPnlLines(LONG, -10, 190, RATE, 1, false)

  it('hides ONLY the commission line', () => {
    expect(keys(lines)).toEqual(['Gross P&L', 'Net P&L'])
    expect(lines.find((l) => l.k === 'Commission')).toBeUndefined()
  })

  it('still shows gross and net, both correct', () => {
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹8,300')
    expect(valueOf(lines, 'Net P&L')).toBe('+₹8,300')
  })

  it('net equals gross, because nothing is actually charged when the toggle is off', () => {
    expect(valueOf(lines, 'Net P&L')).toBe(valueOf(lines, 'Gross P&L'))
  })

  it('gross is unchanged from the commission-ON case', () => {
    const on = orderPnlLines(LONG, -10, 190, RATE, 1, true)
    expect(valueOf(lines, 'Gross P&L')).toBe(valueOf(on, 'Gross P&L'))
  })

  it('reports a loss without softening it', () => {
    const losing = orderPnlLines(LONG, -10, 170, RATE, 1, false)
    expect(keys(losing)).toEqual(['Gross P&L', 'Net P&L'])
    expect(valueOf(losing, 'Gross P&L')).toBe('−₹8,300')
    expect(valueOf(losing, 'Net P&L')).toBe('−₹8,300')
  })
})

describe('opening fill, commission ON — lone Commission line', () => {
  const lines = orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, true)

  it('shows Commission alone, with no Gross and no Net', () => {
    expect(keys(lines)).toEqual(['Commission'])
  })

  it('shows the commission that will actually be charged', () => {
    // 0.003 × 10 × 180 × 83 = ₹448.20
    expect(valueOf(lines, 'Commission')).toBe('−₹448')
    expect(lines[0].tone).toBe('destructive')
  })

  it('treats an absent position the same as flat', () => {
    expect(orderPnlLines(null, 10, 180, RATE, 1, true)).toEqual(lines)
  })

  it('charges an opening SHORT identically to an opening long', () => {
    const short = orderPnlLines(FLAT_CASH, -10, 180, RATE, 1, true)
    expect(keys(short)).toEqual(['Commission'])
    expect(valueOf(short, 'Commission')).toBe('−₹448')
  })

  it('shows the same lone line when ADDING to an existing position', () => {
    const addLong = orderPnlLines(LONG, 5, 190, RATE, 1, true)
    expect(keys(addLong)).toEqual(['Commission'])
    expect(valueOf(addLong, 'Commission')).toBe('−₹237') // 0.003 × 5 × 190 × 83 = 236.55

    const addShort = orderPnlLines(SHORT, -5, 170, RATE, 1, true)
    expect(keys(addShort)).toEqual(['Commission'])
    expect(valueOf(addShort, 'Commission')).toBe('−₹212') // 0.003 × 5 × 170 × 83 = 211.65
  })

  it('scales with order size', () => {
    expect(valueOf(orderPnlLines(FLAT_CASH, 20, 180, RATE, 1, true), 'Commission')).toBe('−₹896')
  })
})

describe('opening fill, commission OFF — nothing at all', () => {
  it('shows no lines, since nothing is realized and nothing is charged', () => {
    expect(orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, false)).toEqual([])
    expect(orderPnlLines(null, 10, 180, RATE, 1, false)).toEqual([])
    expect(orderPnlLines(FLAT_CASH, -10, 180, RATE, 1, false)).toEqual([])
  })

  it('shows no lines when adding to an existing position either', () => {
    expect(orderPnlLines(LONG, 5, 190, RATE, 1, false)).toEqual([])
    expect(orderPnlLines(SHORT, -5, 170, RATE, 1, false)).toEqual([])
  })
})

describe('an opening fill never reports realized P&L', () => {
  it('omits Gross and Net whether or not commission is on', () => {
    for (const lines of [
      orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, true),
      orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, false),
      orderPnlLines(LONG, 5, 190, RATE, 1, true),
      orderPnlLines(SHORT, -5, 170, RATE, 1, false),
    ]) {
      expect(lines.find((l) => l.k === 'Gross P&L')).toBeUndefined()
      expect(lines.find((l) => l.k === 'Net P&L')).toBeUndefined()
    }
  })
})

describe('unusable input', () => {
  it('shows nothing for a blank or zero quantity', () => {
    expect(orderPnlLines(LONG, NaN, 190, RATE, 1, true)).toEqual([])
    expect(orderPnlLines(LONG, 0, 190, RATE, 1, true)).toEqual([])
    expect(orderPnlLines(FLAT_CASH, NaN, 180, RATE, 1, true)).toEqual([])
  })

  it('shows nothing for a blank or non-positive price', () => {
    expect(orderPnlLines(LONG, -10, NaN, RATE, 1, true)).toEqual([])
    expect(orderPnlLines(LONG, -10, 0, RATE, 1, true)).toEqual([])
    expect(orderPnlLines(FLAT_CASH, 10, NaN, RATE, 1, true)).toEqual([])
  })
})

describe('toCashPosition — snapshot PositionView → engine CashPosition', () => {
  it('keeps a long basis positive', () => {
    expect(toCashPosition({ qty: 10, avgPrice: 180, leverage: 1, costBasisInr: 149_400 })).toEqual(LONG)
  })

  it('re-signs an unsigned cost basis for a SHORT', () => {
    // The API sends costBasisInr unsigned; the engine needs it signed like qty.
    expect(toCashPosition({ qty: -10, avgPrice: 180, leverage: 1, costBasisInr: 149_400 })).toEqual(SHORT)
  })

  it('treats flat, null and undefined as no position', () => {
    expect(toCashPosition({ qty: 0, avgPrice: 0, leverage: 1, costBasisInr: 0 })).toBeNull()
    expect(toCashPosition(null)).toBeNull()
    expect(toCashPosition(undefined)).toBeNull()
  })

  it('carries leverage through untouched', () => {
    expect(toCashPosition({ qty: 10, avgPrice: 180, leverage: 5, costBasisInr: 149_400 })!.leverage).toBe(5)
  })

  it('a short closed through the adapter profits when the price falls', () => {
    const short = toCashPosition({ qty: -10, avgPrice: 180, leverage: 1, costBasisInr: 149_400 })
    const lines = orderPnlLines(short, 10, 170, RATE, 1, true)
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹8,300') // not −₹8,300
  })
})

describe('pnlBreakdownLines', () => {
  it('renders nothing for a null breakdown', () => {
    expect(pnlBreakdownLines(null, true)).toEqual([])
    expect(pnlBreakdownLines(null, false)).toEqual([])
  })

  it('drops the commission row purely on the toggle, not on the amount', () => {
    const breakdown = { closedQty: 10, grossPnlInr: 8_300, commissionInr: 473.1, netPnlInr: 7_826.9 }
    expect(keys(pnlBreakdownLines(breakdown, true))).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
    expect(keys(pnlBreakdownLines(breakdown, false))).toEqual(['Gross P&L', 'Net P&L'])
  })
})
