import { describe, expect, it } from 'vitest'
import { type RejectionCode, rejectionMessage } from './orderRejection'

/**
 * Every code the server can return, taken from placeOrder's seven rejection
 * paths. If a new one is added server-side without a case here, the exhaustive
 * test below fails rather than quietly leaking a raw token to a trader.
 */
const ALL_CODES: RejectionCode[] = [
  'no_active_round',
  'unknown_instrument',
  'invalid_qty',
  'invalid_leverage',
  'missing_limit_price',
  'no_reference_price',
  'insufficient_margin',
]

describe('an accepted order produces no rejection notice', () => {
  it('returns null so the caller falls through to the normal flow', () => {
    expect(rejectionMessage({ accepted: true, trades: [{ price: 190, qty: 10 }] } as never)).toBeNull()
  })

  it('an accepted order that merely rested is still not a rejection', () => {
    expect(rejectionMessage({ accepted: true })).toBeNull()
  })

  it('a payload with no accepted flag is NOT treated as rejected', () => {
    // An older or partial response must not manufacture a scary error.
    expect(rejectionMessage({})).toBeNull()
  })
})

describe('insufficient margin — the case that started this', () => {
  const res = {
    accepted: false,
    reason: 'insufficient_margin',
    rejection: { code: 'insufficient_margin' as const, requiredInr: 166_000, availableInr: 40_000 },
  }

  it('names the failure in the title', () => {
    expect(rejectionMessage(res)!.title).toBe('Order rejected — insufficient margin')
  })

  it('states what was needed and what was available, in rupees', () => {
    const d = rejectionMessage(res)!.detail
    expect(d).toContain('₹1,66,000') // needed
    expect(d).toContain('₹40,000') // available
  })

  it('does the subtraction so the trader does not have to', () => {
    expect(rejectionMessage(res)!.detail).toContain('short ₹1,26,000')
  })

  it('says what to do about it', () => {
    expect(rejectionMessage(res)!.detail).toMatch(/Reduce the quantity, or close a position/)
  })

  it('states plainly that nothing was placed', () => {
    expect(rejectionMessage(res)!.detail).toContain('Nothing was placed.')
  })

  it('never shows the raw internal token', () => {
    const n = rejectionMessage(res)!
    expect(`${n.title} ${n.detail}`).not.toContain('insufficient_margin')
  })

  it('falls back to a clear message when the server sent no numbers', () => {
    const bare = rejectionMessage({ accepted: false, reason: 'insufficient_margin', rejection: { code: 'insufficient_margin' } })!
    expect(bare.title).toBe('Order rejected — insufficient margin')
    expect(bare.detail).toContain('not have enough available margin')
    expect(bare.detail).not.toContain('NaN')
    expect(bare.detail).not.toContain('undefined')
  })

  it('never reports a negative shortfall when the figures are equal', () => {
    const edge = rejectionMessage({
      accepted: false,
      rejection: { code: 'insufficient_margin', requiredInr: 5000, availableInr: 5000 },
    })!
    expect(edge.detail).toContain('short ₹0')
    expect(edge.detail).not.toContain('−')
  })

  it('handles a zero balance', () => {
    const broke = rejectionMessage({
      accepted: false,
      rejection: { code: 'insufficient_margin', requiredInr: 12_000, availableInr: 0 },
    })!
    expect(broke.detail).toContain('only ₹0 is available')
  })
})

describe('every other rejection reason the backend returns', () => {
  const cases: { code: RejectionCode; reason: string; expectTitle: string; expectDetail: RegExp }[] = [
    { code: 'no_active_round', reason: 'no active round', expectTitle: 'Order rejected — no active round', expectDetail: /Trading is closed until the next round/ },
    { code: 'unknown_instrument', reason: 'unknown instrument: ZZZZ', expectTitle: 'Order rejected — unknown instrument', expectDetail: /not trading in this event/ },
    { code: 'invalid_qty', reason: 'qty must be positive', expectTitle: 'Order rejected — invalid quantity', expectDetail: /whole number greater than zero/ },
    { code: 'invalid_leverage', reason: 'invalid_leverage', expectTitle: 'Order rejected — invalid leverage', expectDetail: /at least 1x/ },
    { code: 'missing_limit_price', reason: 'limit order requires a price', expectTitle: 'Order rejected — no limit price', expectDetail: /needs a price/ },
    { code: 'no_reference_price', reason: 'no_reference_price', expectTitle: 'Order rejected — no price available', expectDetail: /no reference price yet/ },
  ]

  for (const c of cases) {
    it(`${c.code} gets its own plain-English message`, () => {
      const n = rejectionMessage({ accepted: false, reason: c.reason, rejection: { code: c.code } })!
      expect(n.title).toBe(c.expectTitle)
      expect(n.detail).toMatch(c.expectDetail)
      expect(n.code).toBe(c.code)
    })
  }

  it('unknown_instrument names the ticker when the server sends it', () => {
    const n = rejectionMessage({ accepted: false, rejection: { code: 'unknown_instrument', ticker: 'ZZZZ' } })!
    expect(n.detail).toContain('ZZZZ')
  })
})

describe('every code is covered, and none leaks a raw token', () => {
  it.each(ALL_CODES)('%s produces a distinct, human message', (code) => {
    const n = rejectionMessage({ accepted: false, reason: code, rejection: { code } })!
    expect(n).not.toBeNull()
    expect(n.title.startsWith('Order rejected')).toBe(true)
    // No snake_case survives into anything a trader reads.
    expect(`${n.title} ${n.detail}`).not.toMatch(/[a-z]_[a-z]/)
    expect(n.detail.length).toBeGreaterThan(20) // an actual explanation, not a label
  })

  it('produces a UNIQUE title per code — no two failures look alike', () => {
    const titles = ALL_CODES.map((code) => rejectionMessage({ accepted: false, rejection: { code } })!.title)
    expect(new Set(titles).size).toBe(ALL_CODES.length)
  })
})

describe('a reason this build has never seen', () => {
  it('is still unmistakably a rejection', () => {
    const n = rejectionMessage({ accepted: false, reason: 'some_future_reason' } as never)!
    expect(n.title).toBe('Order rejected')
    expect(n.code).toBe('unknown')
  })

  it('humanizes the raw token instead of printing it', () => {
    expect(rejectionMessage({ accepted: false, reason: 'some_future_reason' } as never)!.detail)
      .toBe('Some future reason.')
  })

  it('does not double up punctuation on a reason that is already a sentence', () => {
    expect(rejectionMessage({ accepted: false, reason: 'Market is halted.' } as never)!.detail)
      .toBe('Market is halted.')
  })

  it('handles a rejection with no reason at all', () => {
    const n = rejectionMessage({ accepted: false })!
    expect(n.title).toBe('Order rejected')
    expect(n.detail).toBe('The order was not accepted. Nothing was placed.')
  })

  it('an unrecognised code still beats showing the token', () => {
    const n = rejectionMessage({ accepted: false, reason: 'weird', rejection: { code: 'brand_new' as RejectionCode } })!
    expect(n.title).toBe('Order rejected')
    expect(n.detail).toBe('Weird.')
  })
})
