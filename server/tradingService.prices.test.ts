// @vitest-environment node
/**
 * Master-controlled instrument starting prices.
 *
 * The subtle requirement is that this must work before EVERY round, not just
 * the first: `ltp()` reads `lastPrice ?? referencePrice`, and once any trade has
 * printed, `lastPrice` is populated — so writing `reference_price` alone would
 * persist to the DB and change nothing a team can see. These tests pin that,
 * along with master-only gating, repeat use, batch atomicity and the audit log.
 *
 * The DB is an in-memory fake covering the query shapes the service uses.
 */
import { describe, it, expect } from 'vitest'
import { RoundController, type EventConfig } from '@iimb-trading/engine'
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
  not(col: string): this {
    this.filters.push((r) => r[col] !== null && r[col] !== undefined)
    return this
  }
  or(expr: string): this {
    const ids = [...expr.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].split(',')).filter(Boolean)
    this.filters.push((r) => ids.includes(r.buy_order_id) || ids.includes(r.sell_order_id))
    return this
  }
  order(): this {
    return this
  }
  limit(): this {
    return this
  }
  gte(): this {
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
    const out = all.filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r }))
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
  instrument(ticker: string): Row | undefined {
    return this.rows('instruments').find((i) => i.ticker === ticker)
  }
  priceEvents(): Row[] {
    return this.rows('event_log').filter((e) => e.event_type === 'instrument_price_set')
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const MASTER = { accountId: 'acct-master', role: 'master' }
const TEAM = { accountId: 'acct-a', role: 'team' }
const A = 'acct-a'
const B = 'acct-b'
const START_CASH = 10_000_000

const SCHEDULE: EventConfig = [
  { id: 'r1', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: 83 },
  { id: 'r2', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: 83 },
  { id: 'r3', mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: 83 },
]

function harness() {
  const db = new FakeDb({
    instruments: [
      { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 230 },
      { id: 'i-nvda', ticker: 'NVDA', name: 'NVIDIA', sector: 'Tech', reference_price: 128 },
      { id: 'i-ko', ticker: 'KO', name: 'Coca-Cola', sector: 'Staples', reference_price: 60 },
    ],
    profiles: [
      { id: A, username: 'team01', team_name: 'A', role: 'team', starting_cash: START_CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: B, username: 'team02', team_name: 'B', role: 'team', starting_cash: START_CASH, realized_pnl: 0, realized_pnl_inr: 0 },
      { id: 'acct-master', username: 'master', team_name: null, role: 'master', starting_cash: 0, realized_pnl: 0, realized_pnl_inr: 0 },
    ],
  })
  const rounds = new RoundController(SCHEDULE)
  const svc = new TradingService(db as unknown as SupabaseClient, rounds)
  return { db, rounds, svc }
}

async function cross(svc: TradingService, opts: { buyer: string; seller: string; qty: number; price: number }) {
  await svc.placeOrder({ accountId: opts.seller, ticker: 'AAPL', side: 'sell', type: 'limit', price: opts.price, qty: opts.qty, leverage: 1 })
  return svc.placeOrder({ accountId: opts.buyer, ticker: 'AAPL', side: 'buy', type: 'limit', price: opts.price, qty: opts.qty, leverage: 1 })
}

// ---------------------------------------------------------------------------

describe('setInstrumentPrices: updates the price correctly', () => {
  it('writes reference_price to the DB', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()

    const res = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])
    expect(res.applied).toBe(true)
    expect(Number(db.instrument('AAPL')!.reference_price)).toBe(250)
  })

  it('reports the old and new prices in the result', async () => {
    const { svc } = harness()
    await svc.loadInstruments()

    const res = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])
    expect(res.changes).toEqual([{ ticker: 'AAPL', oldPrice: 230, newPrice: 250, oldReferencePrice: 230 }])
  })

  it('updates several instruments in one call', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()

    const res = await svc.setInstrumentPrices(MASTER, [
      { ticker: 'AAPL', price: 250 },
      { ticker: 'NVDA', price: 140 },
      { ticker: 'KO', price: 65 },
    ])
    expect(res.applied).toBe(true)
    expect(res.changes).toHaveLength(3)
    expect(Number(db.instrument('AAPL')!.reference_price)).toBe(250)
    expect(Number(db.instrument('NVDA')!.reference_price)).toBe(140)
    expect(Number(db.instrument('KO')!.reference_price)).toBe(65)
  })

  it('leaves instruments not named in the call alone', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()

    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])
    expect(Number(db.instrument('NVDA')!.reference_price)).toBe(128)
    expect(svc.ltp('NVDA')).toBe(128)
  })

  it('accepts fractional prices', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 231.57 }])
    expect(svc.ltp('AAPL')).toBeCloseTo(231.57, 9)
  })
})

describe('setInstrumentPrices: reflected as the new LTP before any trades', () => {
  it('ltp() returns the new price immediately', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    expect(svc.ltp('AAPL')).toBe(230)

    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])
    expect(svc.ltp('AAPL')).toBe(250)
  })

  it('the instrument catalogue teams bootstrap from shows the new price', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])

    const aapl = svc.instrumentCatalogue().find((i) => i.ticker === 'AAPL')!
    expect(aapl.referencePrice).toBe(250)
  })

  it("the teams' instrument list shows the new price as ltp", async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])

    const rows = await svc.instrumentsWithPositions(A)
    expect(rows.find((r) => r.ticker === 'AAPL')!.ltp).toBe(250)
  })

  it('the price becomes the baseline of an untraded chart', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])

    const history = await svc.priceHistory('AAPL', 600)
    expect(history).toHaveLength(1)
    expect(history[0].price).toBe(250)
    expect(history[0].qty).toBe(0)
  })

  it('a market order placed after the reset values against the new price', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])
    await svc.startRound(0)

    // No mark supplied → the service falls back to the last price, which is now 250.
    const rested = await svc.placeOrder({ accountId: B, ticker: 'AAPL', side: 'sell', type: 'limit', price: 250, qty: 5, leverage: 1 })
    expect(rested.accepted).toBe(true)
    const mkt = await svc.placeOrder({ accountId: A, ticker: 'AAPL', side: 'buy', type: 'market', qty: 5, leverage: 1 })
    expect(mkt.accepted).toBe(true)
    expect(mkt.bestPriceAtSubmit).toBe(250)
  })
})

describe('setInstrumentPrices: overrides a stale last-traded price', () => {
  /**
   * The whole reason this writes lastPrice as well as reference_price. After a
   * round has traded, lastPrice is populated and reference_price is invisible.
   */
  it('resets the LTP that a previous round left behind', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 5, price: 300 })
    expect(svc.ltp('AAPL')).toBe(300) // round 1 left the mark here
    await svc.endRound(600)

    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 200 }])
    expect(svc.ltp('AAPL')).toBe(200) // round 2 starts from the Master's price
  })

  it('reports the traded price as the old price, not the stale reference', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 5, price: 300 })
    await svc.endRound(600)

    const res = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 200 }])
    expect(res.changes[0].oldPrice).toBe(300) // what teams actually saw
    expect(res.changes[0].oldReferencePrice).toBe(230) // the untouched seed
    expect(Number(db.instrument('AAPL')!.reference_price)).toBe(200)
  })

  it('the reset price survives into the next round', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    await cross(svc, { buyer: A, seller: B, qty: 5, price: 300 })
    await svc.endRound(600)

    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 200 }])
    await svc.startRound(700)
    expect(svc.ltp('AAPL')).toBe(200)
  })
})

describe('setInstrumentPrices: repeatable round after round', () => {
  it('applies three sequential resets, each winning', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()

    for (const p of [240, 260, 275]) {
      const res = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: p }])
      expect(res.applied).toBe(true)
      expect(svc.ltp('AAPL')).toBe(p)
    }
    expect(Number(db.instrument('AAPL')!.reference_price)).toBe(275)
  })

  it('chains old → new across calls with no gaps', async () => {
    const { svc } = harness()
    await svc.loadInstruments()

    const a = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 240 }])
    const b = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 260 }])
    expect(a.changes[0]).toMatchObject({ oldPrice: 230, newPrice: 240 })
    expect(b.changes[0]).toMatchObject({ oldPrice: 240, newPrice: 260 })
  })

  it('survives a full round-trade-round-trade cycle', async () => {
    const { svc } = harness()
    await svc.loadInstruments()

    // Round 1 at a Master-set 240, trades up to 310.
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 240 }])
    await svc.startRound(0)
    expect(svc.ltp('AAPL')).toBe(240)
    await cross(svc, { buyer: A, seller: B, qty: 2, price: 310 })
    await svc.endRound(600)
    expect(svc.ltp('AAPL')).toBe(310)

    // Round 2 reset back down to 180, trades up to 190.
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 180 }])
    await svc.startRound(700)
    expect(svc.ltp('AAPL')).toBe(180)
    await cross(svc, { buyer: A, seller: B, qty: 2, price: 190 })
    await svc.endRound(1300)
    expect(svc.ltp('AAPL')).toBe(190)

    // Round 3 reset again.
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 205 }])
    expect(svc.ltp('AAPL')).toBe(205)
  })

  it('has no call-count limit', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    for (let i = 1; i <= 25; i++) {
      const res = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 100 + i }])
      expect(res.applied).toBe(true)
    }
    expect(svc.ltp('AAPL')).toBe(125)
  })
})

describe('setInstrumentPrices: master-only', () => {
  it('refuses a team account', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()

    const res = await svc.setInstrumentPrices(TEAM, [{ ticker: 'AAPL', price: 250 }])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('forbidden')
    expect(svc.ltp('AAPL')).toBe(230) // unchanged
    expect(Number(db.instrument('AAPL')!.reference_price)).toBe(230)
  })

  it('refuses a market maker', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    const res = await svc.setInstrumentPrices({ accountId: 'acct-mm', role: 'market_maker' }, [{ ticker: 'AAPL', price: 250 }])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('forbidden')
  })

  it('writes no audit event when refused', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(TEAM, [{ ticker: 'AAPL', price: 250 }])
    expect(db.priceEvents()).toHaveLength(0)
  })

  it('allows the master', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    expect((await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])).applied).toBe(true)
  })
})

describe('setInstrumentPrices: refused while a round is active', () => {
  it('rejects mid-round, since the mark drives liquidation', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)

    const res = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('cannot set prices while a round is active')
    expect(svc.ltp('AAPL')).toBe(230)
  })

  it('allows it again once the round ends', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    await svc.startRound(0)
    await svc.endRound(600)

    expect((await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])).applied).toBe(true)
    expect(svc.ltp('AAPL')).toBe(250)
  })
})

describe('setInstrumentPrices: validation is all-or-nothing', () => {
  it('rejects an unknown ticker and applies nothing', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()

    const res = await svc.setInstrumentPrices(MASTER, [
      { ticker: 'AAPL', price: 250 },
      { ticker: 'TSLA', price: 400 }, // not in this catalogue
    ])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('unknown instrument: TSLA')
    expect(Number(db.instrument('AAPL')!.reference_price)).toBe(230) // untouched
    expect(svc.ltp('AAPL')).toBe(230)
  })

  it('rejects a non-positive price and applies nothing', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()

    for (const bad of [0, -5]) {
      const res = await svc.setInstrumentPrices(MASTER, [
        { ticker: 'AAPL', price: 250 },
        { ticker: 'NVDA', price: bad },
      ])
      expect(res.applied).toBe(false)
      expect(res.reason).toBe('price must be a positive number for NVDA')
    }
    expect(Number(db.instrument('AAPL')!.reference_price)).toBe(230)
  })

  it('rejects NaN', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    const res = await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: Number.NaN }])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('price must be a positive number for AAPL')
  })

  it('rejects a duplicated ticker rather than guessing', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    const res = await svc.setInstrumentPrices(MASTER, [
      { ticker: 'AAPL', price: 250 },
      { ticker: 'AAPL', price: 260 },
    ])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('duplicate instrument: AAPL')
    expect(svc.ltp('AAPL')).toBe(230)
  })

  it('rejects an empty batch', async () => {
    const { svc } = harness()
    await svc.loadInstruments()
    const res = await svc.setInstrumentPrices(MASTER, [])
    expect(res.applied).toBe(false)
    expect(res.reason).toBe('no price updates supplied')
  })
})

describe('setInstrumentPrices: audit log', () => {
  it('logs one instrument_price_set per instrument, attributed to the master', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [
      { ticker: 'AAPL', price: 250 },
      { ticker: 'NVDA', price: 140 },
    ])

    const events = db.priceEvents()
    expect(events).toHaveLength(2)
    for (const e of events) expect(e.account_id).toBe('acct-master')
  })

  it('records instrument, old price and new price', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 250 }])

    expect(db.priceEvents()[0].payload).toMatchObject({
      instrument: 'AAPL',
      oldPrice: 230,
      newPrice: 250,
      oldReferencePrice: 230,
    })
  })

  it('accumulates one event per call across repeated resets', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 240 }])
    await svc.setInstrumentPrices(MASTER, [{ ticker: 'AAPL', price: 260 }])

    const events = db.priceEvents()
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.payload.newPrice)).toEqual([240, 260])
    expect(events.map((e) => e.payload.oldPrice)).toEqual([230, 240])
  })

  it('writes nothing when the batch is rejected', async () => {
    const { db, svc } = harness()
    await svc.loadInstruments()
    await svc.setInstrumentPrices(MASTER, [
      { ticker: 'AAPL', price: 250 },
      { ticker: 'TSLA', price: 400 },
    ])
    expect(db.priceEvents()).toHaveLength(0)
  })
})
