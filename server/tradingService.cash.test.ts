// @vitest-environment node
/**
 * Integration tests for INR cash settlement as WIRED INTO TradingService.
 *
 * packages/engine/test/cash.test.ts proves the pure math. This file proves the
 * service actually uses it: that a buy debits margin ÷ leverage, that a held
 * position is never revalued no matter where the mark goes, that a sell settles
 * at the round's pinned rate at SELL time, that partial sells realize
 * proportionally, that a short open cannot fund buying power, and that
 * unrealized P&L is gone from every read the teams and Master see.
 *
 * The DB is an in-memory fake covering the query shapes the service uses.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_USD_INR_RATE, RoundController, type EventConfig } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'

type Row = Record<string, any>

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private payload: Row | Row[] = {}
  private conflictCols: string[] = ['id']
  private filters: ((r: Row) => boolean)[] = []
  private sortKey: string | null = null
  private ascending = true
  private one = false

  constructor(
    private readonly tables: Record<string, Row[]>,
    private readonly table: string,
  ) {}

  select(): this {
    return this
  }
  insert(rows: Row | Row[]): this {
    this.op = 'insert'
    this.payload = rows
    return this
  }
  update(patch: Row): this {
    this.op = 'update'
    this.payload = patch
    return this
  }
  upsert(row: Row, opts?: { onConflict?: string }): this {
    this.op = 'upsert'
    this.payload = row
    if (opts?.onConflict) this.conflictCols = opts.onConflict.split(',').map((s) => s.trim())
    return this
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val)
    return this
  }
  neq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] !== val)
    return this
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes(r[col]))
    return this
  }
  not(col: string, _op: string, _val: unknown): this {
    this.filters.push((r) => r[col] !== null && r[col] !== undefined)
    return this
  }
  /** Only used by tradeHistory: buy_order_id.in.(...) OR sell_order_id.in.(...). */
  or(expr: string): this {
    const ids = [...expr.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(',')).filter(Boolean)
    this.filters.push((r) => ids.includes(r.buy_order_id) || ids.includes(r.sell_order_id))
    return this
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.sortKey = col
    this.ascending = opts?.ascending !== false
    return this
  }
  limit(): this {
    return this
  }
  single(): this {
    this.one = true
    return this
  }
  maybeSingle(): this {
    this.one = true
    return this
  }

  private run(): { data: unknown; error: null } {
    const all = this.tables[this.table]
    if (this.op === 'insert') {
      const added = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r) => ({
        created_at: new Date().toISOString(),
        ...r,
      }))
      all.push(...added)
      return { data: added, error: null }
    }
    if (this.op === 'update') {
      const hit = all.filter((r) => this.filters.every((f) => f(r)))
      for (const r of hit) Object.assign(r, this.payload)
      return { data: hit, error: null }
    }
    if (this.op === 'upsert') {
      const row = this.payload as Row
      const existing = all.find((r) => this.conflictCols.every((c) => r[c] === row[c]))
      if (existing) Object.assign(existing, row)
      else all.push({ ...row })
      return { data: [row], error: null }
    }
    let out = all.filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r }))
    if (this.sortKey) {
      const k = this.sortKey
      const dir = this.ascending ? 1 : -1
      out = out.sort((a, b) => {
        const x = a[k] as never
        const y = b[k] as never
        return (x > y ? 1 : x < y ? -1 : 0) * dir
      })
    }
    return this.one ? { data: out[0] ?? null, error: null } : { data: out, error: null }
  }

  then<A = { data: unknown; error: null }, B = never>(
    onfulfilled?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null,
    onrejected?: ((r: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

class FakeDb {
  readonly tables: Record<string, Row[]>
  constructor(seed: Record<string, Row[]>) {
    this.tables = { instruments: [], rounds: [], orders: [], trades: [], positions: [], profiles: [], event_log: [], ...seed }
  }
  from(table: string): FakeQuery {
    this.tables[table] ??= []
    return new FakeQuery(this.tables, table)
  }
  rows(t: string): Row[] {
    return this.tables[t] ?? []
  }
  /** The account's open (non-flat) position, if any. */
  position(accountId: string): Row | undefined {
    return this.rows('positions').find((p) => p.account_id === accountId && p.qty !== 0)
  }
  /** The account's position row regardless of qty — survives closing flat. */
  positionRow(accountId: string): Row | undefined {
    return this.rows('positions').find((p) => p.account_id === accountId)
  }
  profile(id: string): Row | undefined {
    return this.rows('profiles').find((p) => p.id === id)
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 230 }
const A = 'acct-a' // buyer in most scenarios
const B = 'acct-b' // counterparty
const START_CASH = 10_000_000 // ₹1 crore each, so margin never binds unintentionally

function schedule(rate: number): EventConfig {
  return [
    { id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: rate },
    { id: 'r2', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: rate },
  ]
}

function harness(opts: { rate?: number; commission?: boolean } = {}) {
  const rate = opts.rate ?? DEFAULT_USD_INR_RATE
  const db = new FakeDb({
    instruments: [{ ...AAPL }],
    profiles: [
      { id: A, username: 'team01', team_name: 'A', role: 'team', starting_cash: START_CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: B, username: 'team02', team_name: 'B', role: 'team', starting_cash: START_CASH, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const config = schedule(rate).map((r) => ({ ...r, commissionEnabled: opts.commission ?? false }))
  const rounds = new RoundController(config)
  const svc = new TradingService(db as unknown as SupabaseClient, rounds)
  return { db, rounds, svc, rate }
}

/** Cross a buy and a sell at `price` so both sides fill for `qty`. */
async function cross(
  svc: TradingService,
  opts: { buyer: string; seller: string; qty: number; price: number; leverage?: number },
) {
  const leverage = opts.leverage ?? 1
  await svc.placeOrder({ accountId: opts.seller, ticker: 'AAPL', side: 'sell', type: 'limit', price: opts.price, qty: opts.qty, leverage })
  return svc.placeOrder({ accountId: opts.buyer, ticker: 'AAPL', side: 'buy', type: 'limit', price: opts.price, qty: opts.qty, leverage })
}

// ---------------------------------------------------------------------------

describe('service: BUY locks an INR basis and debits margin ÷ leverage', () => {
  it('writes the full notional basis and charges only the margin', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)

    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 5 })

    const pos = db.position(A)!
    expect(Number(pos.qty)).toBe(10)
    expect(Number(pos.avg_price)).toBe(230)
    expect(Number(pos.notional_basis_inr)).toBeCloseTo(190_900, 6) // FULL notional
    expect(Number(pos.leverage)).toBe(5)

    // Cash reflects margin only: 190,900 / 5 = 38,180 locked.
    const state = await svc.getAccountState(A)
    expect(state.marginUsedInr).toBeCloseTo(38_180, 6)
    expect(state.availableMarginInr).toBeCloseTo(START_CASH - 38_180, 6)
    expect(state.realizedPnlInr).toBe(0)
  })

  it('exposes entry rate and cost basis on the position view', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 5 })

    const [p] = (await svc.getAccountState(A)).positions
    expect(p.entryRateInr).toBeCloseTo(83, 9)
    expect(p.costBasisInr).toBeCloseTo(190_900, 6)
    expect(p.marginUsedInr).toBeCloseTo(38_180, 6)
    // Liquidation still reported — risk measure, unaffected by cash settlement.
    expect(p.liquidationPrice).toBeCloseTo(230 * (1 - 1 / 5), 6)
  })
})

describe('service: HOLDING is never revalued', () => {
  it('moving the mark price changes nothing about the position or equity', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })

    const before = { ...db.position(A)! }
    const equityBefore = (await svc.teamsOverview()).find((t) => t.username === 'team01')!.equityInr

    // Drive the internal mark far away by trading between two OTHER... there are
    // only two accounts, so cross a tiny trade at a wildly different price. That
    // moves lastPrice (LTP) without touching account A's basis.
    await cross(svc, { buyer: B, seller: A, qty: 1, price: 400, leverage: 1 })

    expect(svc.ltp('AAPL')).toBe(400) // the mark really did move

    // A's remaining position keeps its ORIGINAL per-unit basis.
    const after = db.position(A)!
    expect(Number(after.avg_price)).toBe(Number(before.avg_price))
    expect(Number(after.notional_basis_inr) / Number(after.qty)).toBeCloseTo(
      Number(before.notional_basis_inr) / Number(before.qty),
      6,
    )

    // Equity moved ONLY by the P&L realized on the 1 unit sold, never by the mark.
    const equityAfter = (await svc.teamsOverview()).find((t) => t.username === 'team01')!.equityInr
    const realized = Number(db.profile(A)!.realized_pnl_inr)
    expect(equityAfter - equityBefore).toBeCloseTo(realized, 6)
    expect(realized).toBeCloseTo(1 * (400 - 230) * 83, 6) // the sold unit only
  })

  it('leaderboard equity is opening + realized, with no unrealized term', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })

    const board = await svc.leaderboard()
    const a = board.find((t) => t.username === 'team01')!
    // Both sides opened positions and realized nothing, so equity is untouched.
    expect(a.equityInr).toBeCloseTo(START_CASH, 6)
    expect(a.totalPnlInr).toBe(0)
    expect(board.every((t) => t.equityInr === START_CASH)).toBe(true)
  })

  it('the Master overview still reports open position counts', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })

    const teams = await svc.teamsOverview()
    expect(teams.find((t) => t.username === 'team01')!.openPositions).toBe(1)
    expect(teams.find((t) => t.username === 'team02')!.openPositions).toBe(1)
  })
})

describe('service: SELL settles at the round rate in force AT SELL TIME', () => {
  it('uses the new pinned rate after the Master changes it mid-round', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    expect(Number(db.position(A)!.notional_basis_inr)).toBeCloseTo(190_900, 6)

    // Master repins the rate, then A closes at the SAME USD price.
    await svc.setUsdInrRate(85)
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 230, leverage: 1 })

    // Pure FX gain: 10 × 230 × (85 − 83). Zero if the buy-time rate were used.
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(4_600, 6)
    // Closed flat: the row remains but carries no qty and no basis.
    expect(Number(db.positionRow(A)!.qty)).toBe(0)
    expect(Number(db.positionRow(A)!.notional_basis_inr)).toBe(0)
    expect(db.position(A)).toBeUndefined() // no open position left
  })

  it('combines price and rate movement on close', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await svc.setUsdInrRate(85)
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(13_100, 6) // 204,000 − 190,900
  })

  it('records the settlement rate on each trade', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await svc.setUsdInrRate(85)
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const rates = db.rows('trades').map((t) => Number(t.usd_inr_rate))
    expect(rates).toEqual([83, 85])
  })

  it('a levered close returns margin plus the full P&L', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 5 })
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 5 })

    // Full-notional P&L regardless of leverage, and margin fully released.
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(8_300, 6)
    const state = await svc.getAccountState(A)
    expect(state.marginUsedInr).toBeCloseTo(0, 6)
    expect(state.availableMarginInr).toBeCloseTo(START_CASH + 8_300, 6)
  })
})

describe('service: PARTIAL sells realize proportionally', () => {
  it('realizes on the sold portion and keeps the original basis on the rest', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })

    await svc.setUsdInrRate(85)
    await cross(svc, { buyer: B, seller: A, qty: 4, price: 240, leverage: 1 })

    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(5_240, 6) // (20,400−19,090)×4
    const pos = db.position(A)!
    expect(Number(pos.qty)).toBe(6)
    expect(Number(pos.avg_price)).toBe(230) // entry untouched
    expect(Number(pos.notional_basis_inr)).toBeCloseTo(114_540, 6) // 19,090 × 6

    // Entry rate on the remainder is still 83, not the new 85.
    const [p] = (await svc.getAccountState(A)).positions
    expect(p.entryRateInr).toBeCloseTo(83, 6)
  })

  it('staged partial closes total the same as one close', async () => {
    const staged = harness({ rate: 83 })
    await staged.svc.loadInstruments()
    await staged.svc.startRound(0)
    await cross(staged.svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(staged.svc, { buyer: B, seller: A, qty: 4, price: 240, leverage: 1 })
    await cross(staged.svc, { buyer: B, seller: A, qty: 6, price: 240, leverage: 1 })

    const oneShot = harness({ rate: 83 })
    await oneShot.svc.loadInstruments()
    await oneShot.svc.startRound(0)
    await cross(oneShot.svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(oneShot.svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    expect(Number(staged.db.profile(A)!.realized_pnl_inr)).toBeCloseTo(
      Number(oneShot.db.profile(A)!.realized_pnl_inr),
      6,
    )
  })
})

describe('service: a short open cannot fund buying power', () => {
  it('opening a short REDUCES available cash', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)

    const before = (await svc.getAccountState(B)).availableMarginInr

    // B sells to open (A is the buyer, so B ends up short only if B had no long).
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 5 })

    const after = await svc.getAccountState(B)
    expect(Number(after.positions[0].qty)).toBe(-10) // B is short
    expect(after.availableMarginInr).toBeLessThan(before) // margin posted, not credited
    expect(after.availableMarginInr).toBeCloseTo(before - 38_180, 6)
    expect(after.marginUsedInr).toBeCloseTo(38_180, 6)
  })

  it('a short position reports a positive cost basis and entry rate', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })

    const [p] = (await svc.getAccountState(B)).positions
    expect(p.qty).toBe(-10)
    expect(p.costBasisInr).toBeCloseTo(190_900, 6)
    expect(p.entryRateInr).toBeCloseTo(83, 9)
  })
})

describe('service: resting-order reservation is INR ÷ leverage', () => {
  it('reserves notional ÷ leverage in INR', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)

    // Rests: no counterparty.
    await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'limit', price: 200, qty: 10, leverage: 5 })

    // 10 × 200 × 83 / 5 = 33,200
    expect(svc.getReservedMarginInr(A)).toBeCloseTo(33_200, 6)
    const state = await svc.getAccountState(A)
    expect(state.marginReservedInr).toBeCloseTo(33_200, 6)
    expect(state.availableMarginInr).toBeCloseTo(START_CASH - 33_200, 6)
  })

  it('releases the reservation on cancel', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    const o = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'limit', price: 200, qty: 10, leverage: 5 })

    await svc.cancelOrder(o.orderId as string)
    expect(svc.getReservedMarginInr(A)).toBeCloseTo(0, 6)
  })

  it('rejects an order that would exceed available INR cash', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)

    // 1× notional far above ₹1 crore: 10,000 × 230 × 83 = ₹19.09 crore.
    const rejected = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'limit', price: 230, qty: 10_000, leverage: 1 })

    expect(rejected.accepted).toBe(false)
    expect(rejected.reason).toBe('insufficient_margin')
  })

  it('leverage makes an otherwise-unaffordable order affordable', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)

    // 700 × 230 × 83 = ₹1.336 crore > ₹1 crore at 1×, but ₹26.7 lakh at 5×.
    const at1x = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'limit', price: 230, qty: 700, leverage: 1 })
    expect(at1x.accepted).toBe(false)

    const at5x = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'limit', price: 230, qty: 700, leverage: 5 })
    expect(at5x.accepted).toBe(true)
  })
})

describe('service: portfolio has no unrealized P&L, and charges are real', () => {
  it('reports cost basis / entry rate and omits mark-to-market fields', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 5 })

    const p = (await svc.portfolio(A)) as Record<string, any>

    // The removed concepts are genuinely absent, not just zeroed.
    expect(p).not.toHaveProperty('unrealizedPnlInr')
    expect(p).not.toHaveProperty('positionsValueInr')
    expect(p).not.toHaveProperty('realizedPnlUsd')

    const row = (p.inventory as Row[]).find((r) => r.ticker === 'AAPL')!
    expect(row).not.toHaveProperty('pnlM2mInr')
    expect(row).not.toHaveProperty('portfolioValueInr')
    expect(Number(row.costBasisInr)).toBeCloseTo(190_900, 6)
    expect(Number(row.entryRateInr)).toBeCloseTo(83, 9)
    expect(Number(row.marginUsedInr)).toBeCloseTo(38_180, 6)

    // Equity = opening + realized only; cash = equity − margin.
    expect(p.totalPortfolioValueInr).toBeCloseTo(START_CASH, 6)
    expect(p.totalPnlInr).toBe(0)
    expect(p.cashInr).toBeCloseTo(START_CASH - 38_180, 6)
    expect(p.rate).toBe(83)
  })

  it('chargesInr reports commission actually charged, on BOTH fills', async () => {
    const { db, svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    const openCharge = 0.003 * 10 * 230 * 83 // ₹572.70 — the opening buy
    const closeCharge = 0.003 * 10 * 240 * 83 // ₹597.60 — the closing sell
    expect(p.chargesInr).toBeCloseTo(openCharge + closeCharge, 6) // ₹1,170.30
    expect(p.chargesInr).not.toBeCloseTo(closeCharge, 6) // the old, understated figure

    // And it really was deducted from realized P&L, not just displayed.
    expect(Number(db.profile(A)!.realized_pnl_inr)).toBeCloseTo(8_300 - (openCharge + closeCharge), 6)
  })

  it('trade history reconstructs P&L exactly, matching the stored total', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await svc.setUsdInrRate(85)
    await cross(svc, { buyer: B, seller: A, qty: 4, price: 240, leverage: 1 })
    await svc.setUsdInrRate(90)
    await cross(svc, { buyer: B, seller: A, qty: 6, price: 250, leverage: 1 })

    const history = await svc.tradeHistory(A)
    const summed = history.reduce((s, h) => s + h.realizedPnlInr, 0)
    expect(summed).toBeCloseTo(Number(db.profile(A)!.realized_pnl_inr), 4)
    // Each tranche settled at its own rate: 5,240 then 20,460.
    expect(history.map((h) => Math.round(h.realizedPnlInr)).sort((a, b) => a - b)).toEqual([5_240, 20_460])
  })
})

describe('service: the rate is pinned, persisted, and survives restart', () => {
  it('startRound persists the pinned rate and exposes it on round status', async () => {
    const { db, svc } = harness({ rate: 86 })
    await svc.loadInstruments()
    await svc.startRound(0)

    expect(Number(db.rows('rounds')[0].usd_inr_rate)).toBe(86)
    expect(svc.getRoundStatus().usdInrRate).toBe(86)
    expect(svc.rateInr()).toBe(86)
  })

  it('setUsdInrRate persists and logs the change', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)

    await svc.setUsdInrRate(88.5)

    expect(Number(db.rows('rounds')[0].usd_inr_rate)).toBe(88.5)
    expect(svc.rateInr()).toBe(88.5)
    const logged = db.rows('event_log').filter((e) => e.event_type === 'usd_inr_rate_changed')
    expect(logged).toHaveLength(1)
    expect(logged[0].payload).toMatchObject({ roundId: 'r1', usdInrRate: 88.5 })
  })

  it('rehydrate restores the pinned rate, not the config default', async () => {
    const { db, svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)
    await svc.setUsdInrRate(91)

    // Fresh service over the same DB — simulating a restart mid-round.
    const rounds2 = new RoundController(schedule(83))
    const svc2 = new TradingService(db as unknown as SupabaseClient, rounds2)
    await svc2.loadInstruments()
    await svc2.rehydrate()

    expect(svc2.rateInr()).toBe(91) // the pinned rate, not 83
  })

  it('the rate does not move on its own between reads', async () => {
    const { svc } = harness({ rate: 83 })
    await svc.loadInstruments()
    await svc.startRound(0)

    const reads = [svc.rateInr(), svc.rateInr(), svc.rateInr()]
    expect(new Set(reads).size).toBe(1)
    expect(reads[0]).toBe(83)
  })
})

describe('service: trade history charges commission on the FULL fill', () => {
  /**
   * A flip: long 10, then sell 15 — 10 units close and 5 open a short. The live
   * path charges commission on all 15, so the reconstructed history must too.
   * Charging only the closed 10 under-reported it on the Portfolio.
   */
  it('reports the full-fill charge on a flip-through-zero, not the closed portion', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)

    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 15, price: 240, leverage: 1 })

    const history = await svc.tradeHistory(A)
    const flip = history.find((h) => h.qty === 10)!
    expect(flip).toBeDefined()

    const fullFill = 0.003 * 15 * 240 * 83 // ₹896.40 — what settleFill actually charged
    const closedOnly = 0.003 * 10 * 240 * 83 // ₹597.60 — the old, understated figure
    expect(flip.commissionInr).toBeCloseTo(fullFill, 6)
    expect(flip.commissionInr).not.toBeCloseTo(closedOnly, 6)
    expect(flip.commissionInr).toBeGreaterThan(closedOnly)
  })

  it('nets the full-fill commission out of the flip record realized P&L', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)

    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 15, price: 240, leverage: 1 })

    const flip = (await svc.tradeHistory(A)).find((h) => h.qty === 10)!
    expect(flip.grossPnlInr).toBeCloseTo(8_300, 6) // (240 − 230) × 10 × 83, closed units
    expect(flip.realizedPnlInr).toBeCloseTo(8_300 - 0.003 * 15 * 240 * 83, 6)
    expect(flip.realizedPnlInr).toBeCloseTo(flip.grossPnlInr - flip.commissionInr, 9)
  })

  it('leaves an ordinary close unchanged, where fill qty and closed qty agree', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)

    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const close = (await svc.tradeHistory(A))[0]
    expect(close.commissionInr).toBeCloseTo(0.003 * 10 * 240 * 83, 6)
  })

  it('leaves a partial reduce unchanged — the fill closes exactly what it sells', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)

    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 4, price: 240, leverage: 1 })

    const reduce = (await svc.tradeHistory(A))[0]
    expect(reduce.qty).toBe(4)
    expect(reduce.commissionInr).toBeCloseTo(0.003 * 4 * 240 * 83, 6)
  })

  it('still charges nothing when the round has commission disabled', async () => {
    const { svc } = harness({ rate: 83, commission: false })
    await svc.loadInstruments()
    await svc.startRound(0)

    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 15, price: 240, leverage: 1 })

    const flip = (await svc.tradeHistory(A)).find((h) => h.qty === 10)!
    expect(flip.commissionInr).toBe(0)
    expect(flip.realizedPnlInr).toBe(flip.grossPnlInr)
  })

  it('chargesInr on the Portfolio picks up the corrected flip charge', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)

    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 15, price: 240, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    // Opening buy (10 @ 230) plus the full flip fill (15 @ 240).
    expect(p.chargesInr).toBeCloseTo(0.003 * 10 * 230 * 83 + 0.003 * 15 * 240 * 83, 6)
  })
})

describe('service: chargesInr counts every fill, not just realizing ones', () => {
  it('counts an opening fill that has no history record at all', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    expect(p.tradeHistory).toHaveLength(0) // nothing realized yet
    expect(p.chargesInr).toBeCloseTo(0.003 * 10 * 230 * 83, 6) // but a fee WAS charged
  })

  it('accumulates across several opening fills before anything is closed', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: A, seller: B, qty: 5, price: 240, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    expect(p.tradeHistory).toHaveLength(0)
    expect(p.chargesInr).toBeCloseTo(0.003 * 10 * 230 * 83 + 0.003 * 5 * 240 * 83, 6)
  })

  it('is zero when the round has commission disabled, however many fills', async () => {
    const { svc } = harness({ rate: 83, commission: false })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    expect(p.chargesInr).toBe(0)
  })

  it('is zero for an account that has never traded', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)

    const p = (await svc.portfolio(A)) as Record<string, any>
    expect(p.chargesInr).toBe(0)
    expect(p.tradeHistory).toHaveLength(0)
  })

  it('charges both counterparties independently for the same fill', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })

    const pa = (await svc.portfolio(A)) as Record<string, any>
    const pb = (await svc.portfolio(B)) as Record<string, any>
    expect(pa.chargesInr).toBeCloseTo(0.003 * 10 * 230 * 83, 6)
    expect(pb.chargesInr).toBeCloseTo(pa.chargesInr, 6)
  })
})

describe('service: chargesInr and tradeHistory measure different things', () => {
  /**
   * By design these no longer reconcile against each other: history omits fills
   * that realized nothing, while charges counts every fee taken. The invariant
   * that still holds is gross − charges === the stored realized P&L.
   */
  it('chargesInr exceeds the commission visible in the history rows', async () => {
    const { svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    const historyCommission = p.tradeHistory.reduce((s: number, h: any) => s + h.commissionInr, 0)
    expect(historyCommission).toBeCloseTo(0.003 * 10 * 240 * 83, 6) // closing fill only
    expect(p.chargesInr).toBeGreaterThan(historyCommission)
    // The gap is exactly the opening fill's fee, which has no history row.
    expect(p.chargesInr - historyCommission).toBeCloseTo(0.003 * 10 * 230 * 83, 6)
  })

  it('sum(history.realizedPnlInr) does NOT equal the stored realized P&L', async () => {
    const { db, svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const history = await svc.tradeHistory(A)
    const summedNet = history.reduce((s, h) => s + h.realizedPnlInr, 0)
    const stored = Number(db.profile(A)!.realized_pnl_inr)
    expect(summedNet).toBeCloseTo(8_300 - 0.003 * 10 * 240 * 83, 6) // ₹7,702.40
    expect(stored).toBeCloseTo(8_300 - (0.003 * 10 * 230 * 83 + 0.003 * 10 * 240 * 83), 6) // ₹7,129.70
    expect(summedNet).not.toBeCloseTo(stored, 2)
  })

  it('reconciles via gross − charges === stored realized P&L', async () => {
    const { db, svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    const summedGross = p.tradeHistory.reduce((s: number, h: any) => s + h.grossPnlInr, 0)
    expect(summedGross - p.chargesInr).toBeCloseTo(Number(db.profile(A)!.realized_pnl_inr), 6)
  })

  it('reconciles the same way through a flip and a staged close', async () => {
    const { db, svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await cross(svc, { buyer: B, seller: A, qty: 15, price: 240, leverage: 1 }) // flips A short 5
    await cross(svc, { buyer: A, seller: B, qty: 5, price: 220, leverage: 1 }) // covers the short

    const p = (await svc.portfolio(A)) as Record<string, any>
    const summedGross = p.tradeHistory.reduce((s: number, h: any) => s + h.grossPnlInr, 0)
    expect(summedGross - p.chargesInr).toBeCloseTo(Number(db.profile(A)!.realized_pnl_inr), 6)
  })

  it('reconciles when the Master moves the rate between fills', async () => {
    const { db, svc } = harness({ rate: 83, commission: true })
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 10, price: 230, leverage: 1 })
    await svc.setUsdInrRate(90)
    await cross(svc, { buyer: B, seller: A, qty: 10, price: 240, leverage: 1 })

    const p = (await svc.portfolio(A)) as Record<string, any>
    const summedGross = p.tradeHistory.reduce((s: number, h: any) => s + h.grossPnlInr, 0)
    expect(summedGross - p.chargesInr).toBeCloseTo(Number(db.profile(A)!.realized_pnl_inr), 6)
    // Each fill was charged at its OWN rate, not today's.
    expect(p.chargesInr).toBeCloseTo(0.003 * 10 * 230 * 83 + 0.003 * 10 * 240 * 90, 6)
  })
})
