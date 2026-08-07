import { type CashPosition, DEFAULT_COMMISSION_RATE, FLAT_CASH } from '@iimb-trading/engine'
import { describe, expect, it } from 'vitest'
import { orderPnlLines, pnlBreakdownLines, toCashPosition } from './orderConfirm'

const RATE = 83
/** Commission terms: on/off at the engine default rate. */
const ON = { enabled: true, rate: DEFAULT_COMMISSION_RATE }
const OFF = { enabled: false, rate: DEFAULT_COMMISSION_RATE }

/** Long 10 @ $180, basis ₹149,400. */
const LONG: CashPosition = { qty: 10, avgPrice: 180, notionalBasisInr: 149_400, leverage: 1 }
/** Short 10 @ $180, basis −₹149,400. */
const SHORT: CashPosition = { qty: -10, avgPrice: 180, notionalBasisInr: -149_400, leverage: 1 }

const keys = (lines: { k: string }[]) => lines.map((l) => l.k)
const valueOf = (lines: { k: string; v: string }[], k: string) => lines.find((l) => l.k === k)?.v

describe('closing fill, commission ON', () => {
  const lines = orderPnlLines(LONG, -10, 190, RATE, 1, ON)

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
    const losing = orderPnlLines(LONG, -10, 170, RATE, 1, ON)
    expect(valueOf(losing, 'Gross P&L')).toBe('−₹8,300')
    expect(valueOf(losing, 'Net P&L')).toBe('−₹8,723') // loss deepened by ₹423.30
    expect(losing.find((l) => l.k === 'Gross P&L')!.tone).toBe('destructive')
    expect(losing.find((l) => l.k === 'Net P&L')!.tone).toBe('destructive')
  })

  it('shows the breakdown for a partial reduce', () => {
    const partial = orderPnlLines(LONG, -4, 190, RATE, 1, ON)
    expect(keys(partial)).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
    expect(valueOf(partial, 'Gross P&L')).toBe('+₹3,320')
    expect(valueOf(partial, 'Commission')).toBe('−₹189')
    expect(valueOf(partial, 'Net P&L')).toBe('+₹3,131')
  })

  it('shows the breakdown when a BUY closes a short', () => {
    const covering = orderPnlLines(SHORT, 10, 170, RATE, 1, ON)
    expect(keys(covering)).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
    expect(valueOf(covering, 'Gross P&L')).toBe('+₹8,300')
    expect(valueOf(covering, 'Net P&L')).toBe('+₹7,877')
  })
})

/**
 * The toggle is DISPLAY-ONLY: commission is charged in every round. With it off
 * the Commission line is hidden, but Net is still Gross minus the charge — so
 * Net is identical whether the toggle is on or off. A genuinely free round is
 * expressed as rate 0, not as toggle-off.
 */
describe('closing fill, commission OFF — charge still applies, line hidden', () => {
  const lines = orderPnlLines(LONG, -10, 190, RATE, 1, OFF)

  it('hides ONLY the commission line', () => {
    expect(keys(lines)).toEqual(['Gross P&L', 'Net P&L'])
    expect(lines.find((l) => l.k === 'Commission')).toBeUndefined()
  })

  it('still deducts the charge from net, even though it is not itemised', () => {
    expect(valueOf(lines, 'Gross P&L')).toBe('+₹8,300')
    expect(valueOf(lines, 'Net P&L')).toBe('+₹7,827') // 8,300 − 473.10, silently
  })

  it('net does NOT equal gross — the charge is taken either way', () => {
    expect(valueOf(lines, 'Net P&L')).not.toBe(valueOf(lines, 'Gross P&L'))
  })

  it('gross AND net both match the commission-ON case exactly', () => {
    const on = orderPnlLines(LONG, -10, 190, RATE, 1, ON)
    expect(valueOf(lines, 'Gross P&L')).toBe(valueOf(on, 'Gross P&L'))
    expect(valueOf(lines, 'Net P&L')).toBe(valueOf(on, 'Net P&L'))
    // The ONLY difference is the itemised line.
    expect(keys(on)).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
    expect(keys(lines)).toEqual(['Gross P&L', 'Net P&L'])
  })

  it('deepens a loss by the charge, unshown', () => {
    const losing = orderPnlLines(LONG, -10, 170, RATE, 1, OFF)
    expect(keys(losing)).toEqual(['Gross P&L', 'Net P&L'])
    expect(valueOf(losing, 'Gross P&L')).toBe('−₹8,300')
    expect(valueOf(losing, 'Net P&L')).toBe('−₹8,723') // deepened by ₹423.30
  })
})

describe('a zero RATE is what makes a round genuinely free', () => {
  const FREE_ON = { enabled: true, rate: 0 }
  const FREE_OFF = { enabled: false, rate: 0 }

  it('net equals gross at rate 0, with the line shown', () => {
    const lines = orderPnlLines(LONG, -10, 190, RATE, 1, FREE_ON)
    expect(keys(lines)).toEqual(['Gross P&L', 'Commission', 'Net P&L'])
    expect(valueOf(lines, 'Commission')).toBe('₹0')
    expect(valueOf(lines, 'Net P&L')).toBe(valueOf(lines, 'Gross P&L'))
  })

  it('net equals gross at rate 0, with the line hidden', () => {
    const lines = orderPnlLines(LONG, -10, 190, RATE, 1, FREE_OFF)
    expect(keys(lines)).toEqual(['Gross P&L', 'Net P&L'])
    expect(valueOf(lines, 'Net P&L')).toBe(valueOf(lines, 'Gross P&L'))
  })

  it('an opening fill at rate 0 costs nothing', () => {
    expect(valueOf(orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, FREE_ON), 'Commission')).toBe('₹0')
  })
})

describe('a custom rate flows through to the figures', () => {
  it('doubling the rate doubles the commission and deepens net', () => {
    const dbl = orderPnlLines(LONG, -10, 190, RATE, 1, { enabled: true, rate: 0.006 })
    expect(valueOf(dbl, 'Commission')).toBe('−₹946') // 0.006 × 10 × 190 × 83 = 946.20
    expect(valueOf(dbl, 'Net P&L')).toBe('+₹7,354') // 8,300 − 946.20
  })

  it('an opening fill uses the configured rate', () => {
    const lines = orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, { enabled: true, rate: 0.005 })
    expect(valueOf(lines, 'Commission')).toBe('−₹747') // 0.005 × 10 × 180 × 83 = 747
  })
})

describe('opening fill, commission ON — lone Commission line', () => {
  const lines = orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, ON)

  it('shows Commission alone, with no Gross and no Net', () => {
    expect(keys(lines)).toEqual(['Commission'])
  })

  it('shows the commission that will actually be charged', () => {
    // 0.003 × 10 × 180 × 83 = ₹448.20
    expect(valueOf(lines, 'Commission')).toBe('−₹448')
    expect(lines[0].tone).toBe('destructive')
  })

  it('treats an absent position the same as flat', () => {
    expect(orderPnlLines(null, 10, 180, RATE, 1, ON)).toEqual(lines)
  })

  it('charges an opening SHORT identically to an opening long', () => {
    const short = orderPnlLines(FLAT_CASH, -10, 180, RATE, 1, ON)
    expect(keys(short)).toEqual(['Commission'])
    expect(valueOf(short, 'Commission')).toBe('−₹448')
  })

  it('shows the same lone line when ADDING to an existing position', () => {
    const addLong = orderPnlLines(LONG, 5, 190, RATE, 1, ON)
    expect(keys(addLong)).toEqual(['Commission'])
    expect(valueOf(addLong, 'Commission')).toBe('−₹237') // 0.003 × 5 × 190 × 83 = 236.55

    const addShort = orderPnlLines(SHORT, -5, 170, RATE, 1, ON)
    expect(keys(addShort)).toEqual(['Commission'])
    expect(valueOf(addShort, 'Commission')).toBe('−₹212') // 0.003 × 5 × 170 × 83 = 211.65
  })

  it('scales with order size', () => {
    expect(valueOf(orderPnlLines(FLAT_CASH, 20, 180, RATE, 1, ON), 'Commission')).toBe('−₹896')
  })
})

describe('opening fill, commission OFF — charged silently, nothing shown', () => {
  it('shows no lines: nothing is realized, and the charge is not itemised', () => {
    expect(orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, OFF)).toEqual([])
    expect(orderPnlLines(null, 10, 180, RATE, 1, OFF)).toEqual([])
    expect(orderPnlLines(FLAT_CASH, -10, 180, RATE, 1, OFF)).toEqual([])
  })

  it('shows no lines when adding to an existing position either', () => {
    expect(orderPnlLines(LONG, 5, 190, RATE, 1, OFF)).toEqual([])
    expect(orderPnlLines(SHORT, -5, 170, RATE, 1, OFF)).toEqual([])
  })
})

describe('an opening fill never reports realized P&L', () => {
  it('omits Gross and Net whether or not commission is on', () => {
    for (const lines of [
      orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, ON),
      orderPnlLines(FLAT_CASH, 10, 180, RATE, 1, OFF),
      orderPnlLines(LONG, 5, 190, RATE, 1, ON),
      orderPnlLines(SHORT, -5, 170, RATE, 1, OFF),
    ]) {
      expect(lines.find((l) => l.k === 'Gross P&L')).toBeUndefined()
      expect(lines.find((l) => l.k === 'Net P&L')).toBeUndefined()
    }
  })
})

describe('unusable input', () => {
  it('shows nothing for a blank or zero quantity', () => {
    expect(orderPnlLines(LONG, NaN, 190, RATE, 1, ON)).toEqual([])
    expect(orderPnlLines(LONG, 0, 190, RATE, 1, ON)).toEqual([])
    expect(orderPnlLines(FLAT_CASH, NaN, 180, RATE, 1, ON)).toEqual([])
  })

  it('shows nothing for a blank or non-positive price', () => {
    expect(orderPnlLines(LONG, -10, NaN, RATE, 1, ON)).toEqual([])
    expect(orderPnlLines(LONG, -10, 0, RATE, 1, ON)).toEqual([])
    expect(orderPnlLines(FLAT_CASH, 10, NaN, RATE, 1, ON)).toEqual([])
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
    const lines = orderPnlLines(short, 10, 170, RATE, 1, ON)
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
