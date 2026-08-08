// @vitest-environment node
/**
 * The fundamentals reveal gate, applied by the real service against the real
 * query shape.
 *
 * src/lib/fundamentals.test.ts proves the RULE. This proves the service
 * actually applies it — that an unrevealed period never leaves the server, so
 * there is nothing in a network response for a team to find ahead of time.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_USD_INR_RATE, type EventConfig, RoundController } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'
import { FakeDb } from './fakeDb'

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 225 }
const SPY = { id: 'i-spy', ticker: 'SPY', name: 'S&P 500 ETF', sector: 'Broad Market', reference_price: 572 }

/** The five company metrics across Base + P1..P20, as imported. */
function companyRows(ticker: string) {
  return ['revenue', 'ebitda_margin', 'pat_margin', 'eps', 'debt_equity'].flatMap((metric) =>
    Array.from({ length: 21 }, (_, period_index) => ({ ticker, metric, period_index, value: period_index + 1 })),
  )
}
const spyRows = Array.from({ length: 21 }, (_, period_index) => ({
  ticker: 'SPY', metric: 'index_level', period_index, value: 7700 + period_index * 100,
}))

/** `rounds` many real rounds, so real-N can actually be started N times. */
function schedule(count: number): EventConfig {
  return Array.from({ length: count }, (_, i) => ({
    id: i === 0 ? 'mock-1' : `real-${i}`,
    mode: 'only_data' as const,
    durationSeconds: 600,
    commissionEnabled: false,
    usdInrRate: DEFAULT_USD_INR_RATE,
    commissionRate: 0,
  }))
}

async function harness(rounds = 8) {
  const db = new FakeDb({
    instruments: [{ ...AAPL }, { ...SPY }],
    profiles: [{ id: 'a', username: 'team01', role: 'team', starting_cash: 1_000_000, realized_pnl: 0, realized_pnl_inr: 0 }],
    fundamentals: [...companyRows('AAPL'), ...spyRows],
  })
  const svc = new TradingService(db as unknown as SupabaseClient, new RoundController(schedule(rounds)))
  await svc.loadInstruments()
  return { db, svc }
}

/** Start rounds until the active one is `real-N`. */
async function advanceTo(svc: TradingService, n: number) {
  await svc.startRound(0) // mock-1
  for (let i = 0; i < n; i++) {
    await svc.endRound(600)
    await svc.startRound(0)
  }
}

const periods = (pts: { periodIndex: number }[]) => [...new Set(pts.map((p) => p.periodIndex))].sort((a, b) => a - b)

// ---------------------------------------------------------------------------

describe('the service reveals exactly what the round allows', () => {
  it('during the MOCK round, only Base leaves the server', async () => {
    const { svc } = await harness()
    await svc.startRound(0)
    expect(periods(await svc.fundamentals('AAPL'))).toEqual([0])
  })

  it('Round 1 returns Base and P1, and nothing further', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 1)
    expect(periods(await svc.fundamentals('AAPL'))).toEqual([0, 1])
  })

  it('Round 3 returns Base through P3', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 3)
    expect(periods(await svc.fundamentals('AAPL'))).toEqual([0, 1, 2, 3])
  })

  it('keeps pace as more rounds run — nothing is capped', async () => {
    const { svc } = await harness(10)
    await advanceTo(svc, 6)
    expect(periods(await svc.fundamentals('AAPL'))).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('an UNREVEALED period never appears in the payload', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 2)
    const pts = await svc.fundamentals('AAPL')
    expect(pts.some((p) => p.periodIndex > 2)).toBe(false)
  })

  it('every metric is present for the revealed periods', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 2)
    const pts = await svc.fundamentals('AAPL')
    expect(new Set(pts.map((p) => p.metric)).size).toBe(5)
    expect(pts).toHaveLength(5 * 3) // 5 metrics x Base,P1,P2
  })

  it('is cumulative — each round is a superset of the last', async () => {
    const { svc } = await harness(10)
    await svc.startRound(0)
    let previous: number[] = []
    for (let n = 1; n <= 5; n++) {
      await svc.endRound(600)
      await svc.startRound(0)
      const cols = periods(await svc.fundamentals('AAPL'))
      for (const p of previous) expect(cols).toContain(p)
      previous = cols
    }
    expect(previous).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe("SPY's index level is served on the same schedule", () => {
  it('is revealed period by period like any company metric', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 3)
    const pts = await svc.fundamentals('SPY')
    expect(periods(pts)).toEqual([0, 1, 2, 3])
    expect(new Set(pts.map((p) => p.metric))).toEqual(new Set(['index_level']))
  })

  it('carries the real index values', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 1)
    const pts = await svc.fundamentals('SPY')
    expect(pts.find((p) => p.periodIndex === 0)!.value).toBe(7700)
    expect(pts.find((p) => p.periodIndex === 1)!.value).toBe(7800)
  })

  it('a company request never returns the index row', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 2)
    const pts = await svc.fundamentals('AAPL')
    expect(pts.some((p) => p.metric === 'index_level')).toBe(false)
  })
})

describe('edge cases', () => {
  it('before any round has started, only Base is available', async () => {
    const { svc } = await harness()
    expect(periods(await svc.fundamentals('AAPL'))).toEqual([0])
  })

  it('an instrument with no fundamentals returns an empty list, not an error', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 2)
    expect(await svc.fundamentals('NVDA')).toEqual([])
  })

  it('values are numbers, ready to format', async () => {
    const { svc } = await harness()
    await advanceTo(svc, 1)
    for (const p of await svc.fundamentals('AAPL')) {
      expect(typeof p.value).toBe('number')
      expect(Number.isFinite(p.value)).toBe(true)
    }
  })
})
