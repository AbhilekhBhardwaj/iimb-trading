// @vitest-environment node
/**
 * Round-lifecycle regression tests for TradingService.
 *
 * These cover the four state bugs found in the pre-event audit:
 *   (a) rounds never ended on their own — they relied entirely on the Master
 *       clicking "end", so a 5-minute round stayed open for four hours,
 *   (b) rehydrate() only restored an *active* round, so after a restart with
 *       everything ended the controller came back all-'pending' and replayed a
 *       round that had already run,
 *   (c) startRound()'s blind upsert then overwrote that round's real
 *       started_at/ended_at, destroying its history,
 *   (d) endRound() never swept the book, leaving orders resting (and margin
 *       reserved) on a round that had finished.
 *
 * The DB is a small in-memory fake covering exactly the query shapes the
 * service uses, so these run with no network and no Supabase project.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RoundController, type EventConfig } from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { TradingService } from './tradingService'

type Row = Record<string, unknown>

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

/** Chainable query stand-in; awaiting it runs against the seeded tables. */
class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private op: 'select' | 'insert' | 'update' | 'upsert' = 'select'
  private payload: Row | Row[] = {}
  private filters: ((r: Row) => boolean)[] = []
  private sortKey: string | null = null
  private ascending = true
  private rowMode: 'many' | 'one' = 'many'

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
  upsert(row: Row): this {
    this.op = 'upsert'
    this.payload = row
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
  order(col: string, opts?: { ascending?: boolean }): this {
    this.sortKey = col
    this.ascending = opts?.ascending !== false
    return this
  }
  single(): this {
    this.rowMode = 'one'
    return this
  }
  maybeSingle(): this {
    this.rowMode = 'one'
    return this
  }

  private run(): { data: unknown; error: null } {
    const all = this.tables[this.table]
    if (this.op === 'insert') {
      const added = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r) => ({ ...r }))
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
      const existing = all.find((r) => r.id === row.id)
      if (existing) Object.assign(existing, row)
      else all.push({ ...row })
      return { data: [row], error: null }
    }
    let out = all.filter((r) => this.filters.every((f) => f(r))).map((r) => ({ ...r }))
    if (this.sortKey) {
      const k = this.sortKey
      const dir = this.ascending ? 1 : -1
      out = out.sort((a, b) => {
        const x = a[k] as string | number
        const y = b[k] as string | number
        return (x > y ? 1 : x < y ? -1 : 0) * dir
      })
    }
    return this.rowMode === 'one' ? { data: out[0] ?? null, error: null } : { data: out, error: null }
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
  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = {
      instruments: [],
      rounds: [],
      orders: [],
      trades: [],
      positions: [],
      profiles: [],
      event_log: [],
      ...seed,
    }
  }
  from(table: string): FakeQuery {
    this.tables[table] ??= []
    return new FakeQuery(this.tables, table)
  }
  rows(table: string): Row[] {
    return this.tables[table] ?? []
  }
  row(table: string, id: string): Row | undefined {
    return this.rows(table).find((r) => r.id === id)
  }
  /** All round_ended log payloads, oldest first. */
  roundEndedPayloads(): Record<string, unknown>[] {
    return this.rows('event_log')
      .filter((e) => e.event_type === 'round_ended')
      .map((e) => e.payload as Record<string, unknown>)
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AAPL = { id: 'i-aapl', ticker: 'AAPL', name: 'Apple', sector: 'Tech', reference_price: 230 }
const ACCT = 'acct-1'
const T0 = '2026-08-06T10:00:00.000Z'

/** mock-1 (300s) then two real rounds (600s) — mirrors the real event shape. */
function schedule(): EventConfig {
  return [
    { id: 'mock-1', mode: 'data_and_news', durationSeconds: 300, commissionEnabled: false },
    { id: 'real-1', mode: 'only_data', durationSeconds: 600, commissionEnabled: true },
    { id: 'real-2', mode: 'silent', durationSeconds: 600, commissionEnabled: true },
  ]
}

function roundRow(over: Row): Row {
  return {
    index: 0,
    mode: 'data_and_news',
    duration_seconds: 300,
    commission_enabled: false,
    status: 'ended',
    started_at: T0,
    ended_at: '2026-08-06T10:05:00.000Z',
    ...over,
  }
}

function restingOrder(over: Row): Row {
  return {
    account_id: ACCT,
    instrument_id: AAPL.id,
    round_id: 'mock-1',
    side: 'sell',
    type: 'limit',
    price: 248.9,
    qty: 10,
    remaining_qty: 10,
    status: 'active',
    leverage: 1,
    created_at: T0,
    ...over,
  }
}

function makeService(seed: Record<string, Row[]> = {}) {
  const db = new FakeDb({ instruments: [{ ...AAPL }], ...seed })
  const rounds = new RoundController(schedule())
  const svc = new TradingService(db as unknown as SupabaseClient, rounds)
  return { db, rounds, svc }
}

/** Advance the fake clock to `seconds` after T0. */
function atSecondsAfterStart(seconds: number): void {
  vi.setSystemTime(new Date(Date.parse(T0) + seconds * 1000))
}

// ---------------------------------------------------------------------------
// (a) Auto-end
// ---------------------------------------------------------------------------

describe('(a) a round ends itself once its duration elapses', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays active until the last second, then ends with no Master action', async () => {
    const { db, svc } = makeService()
    await svc.startRound(0) // mock-1, 300s

    atSecondsAfterStart(299)
    expect(await svc.maybeAutoEndRound()).toBeNull()
    expect(svc.getRoundStatus().active).toBe(true)

    atSecondsAfterStart(300) // exactly at the scheduled end
    const ended = await svc.maybeAutoEndRound()

    expect(ended?.id).toBe('mock-1')
    expect(svc.getRoundStatus().active).toBe(false)
    expect(db.row('rounds', 'mock-1')?.status).toBe('ended')
  })

  it('marks an elapsed end as automatic, and a Master end as not', async () => {
    const auto = makeService()
    await auto.svc.startRound(0)
    atSecondsAfterStart(300)
    await auto.svc.maybeAutoEndRound()
    expect(auto.db.roundEndedPayloads()[0]).toMatchObject({ roundId: 'mock-1', auto: true })

    const manual = makeService()
    await manual.svc.startRound(0)
    atSecondsAfterStart(120)
    await manual.svc.endRound(120)
    expect(manual.db.roundEndedPayloads()[0]).toMatchObject({ roundId: 'mock-1', auto: false })
  })

  it('is a no-op when no round is active', async () => {
    const { db, svc } = makeService()
    expect(await svc.maybeAutoEndRound()).toBeNull()

    // ...and after a round has already been ended manually.
    await svc.startRound(0)
    await svc.endRound(10)
    atSecondsAfterStart(9999)
    expect(await svc.maybeAutoEndRound()).toBeNull()
    expect(db.roundEndedPayloads()).toHaveLength(1)
  })

  it('ends exactly once when many concurrent callers race at the elapsed moment', async () => {
    const { db, svc } = makeService()
    await svc.startRound(0)
    atSecondsAfterStart(300)

    // Every polling request calls this; they must not double-end or throw
    // 'no active round to end'.
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.maybeAutoEndRound()))

    expect(results.filter((r) => r !== null)).toHaveLength(1)
    expect(db.roundEndedPayloads()).toHaveLength(1)
    expect(db.row('rounds', 'mock-1')?.status).toBe('ended')
  })

  it('a Master end racing the auto-end still ends the round exactly once', async () => {
    const { db, svc } = makeService()
    await svc.startRound(0)
    atSecondsAfterStart(300)

    const settled = await Promise.allSettled([svc.endRound(300), svc.maybeAutoEndRound()])

    // One wins; the loser either no-ops or rejects cleanly. Either way the
    // round ends once and the DB is consistent.
    expect(settled.filter((s) => s.status === 'fulfilled' && s.value !== null)).toHaveLength(1)
    expect(db.roundEndedPayloads()).toHaveLength(1)
    expect(db.row('rounds', 'mock-1')?.status).toBe('ended')
    expect(svc.getRoundStatus().active).toBe(false)
  })

  it('does not end early after a restart part-way through a round', async () => {
    const { svc } = makeService({
      rounds: [roundRow({ id: 'mock-1', index: 0, status: 'active', started_at: T0, ended_at: null })],
    })
    atSecondsAfterStart(100) // 100s into a 300s round when the process comes back
    await svc.rehydrate()

    expect(await svc.maybeAutoEndRound()).toBeNull()
    expect(svc.getRoundStatus().active).toBe(true)
    expect(svc.getRoundStatus().remainingSeconds).toBeCloseTo(200, 0)
  })

  it('a restored round still auto-ends at its ORIGINAL scheduled time', async () => {
    const { db, svc } = makeService({
      rounds: [roundRow({ id: 'mock-1', index: 0, status: 'active', started_at: T0, ended_at: null })],
    })
    atSecondsAfterStart(100)
    await svc.rehydrate()

    atSecondsAfterStart(300) // the original 300s deadline, not 300s from recovery
    const ended = await svc.maybeAutoEndRound()

    expect(ended?.id).toBe('mock-1')
    expect(db.row('rounds', 'mock-1')?.status).toBe('ended')
  })
})

// ---------------------------------------------------------------------------
// (b) Rehydration must not replay finished rounds
// ---------------------------------------------------------------------------

describe('(b) rehydrate reconciles finished rounds so none is replayed', () => {
  it('burns every ended round and starts the NEXT one, not a completed one', async () => {
    const { svc, rounds } = makeService({
      rounds: [
        roundRow({ id: 'mock-1', index: 0, status: 'ended' }),
        roundRow({ id: 'real-1', index: 1, duration_seconds: 600, status: 'ended' }),
      ],
    })

    const recovery = await svc.rehydrate()

    expect(recovery.roundsRestored).toBe(2)
    expect(rounds.getSchedule().map((r) => r.status)).toEqual(['ended', 'ended', 'pending'])

    // The regression: before the fix this returned 'mock-1' all over again.
    const next = await svc.startRound(0)
    expect(next.id).toBe('real-2')
  })

  it('re-activates an active round with its true remaining time', async () => {
    vi.useFakeTimers()
    try {
      atSecondsAfterStart(300) // 300s into real-1 (600s), one round already done
      const { svc } = makeService({
        rounds: [
          roundRow({ id: 'mock-1', index: 0, status: 'ended' }),
          roundRow({
            id: 'real-1',
            index: 1,
            duration_seconds: 600,
            status: 'active',
            started_at: T0,
            ended_at: null,
          }),
        ],
      })

      const recovery = await svc.rehydrate()

      expect(recovery.roundsRestored).toBe(2) // one ended + one re-activated
      const status = svc.getRoundStatus()
      expect(status).toMatchObject({ active: true, id: 'real-1', index: 1, mode: 'only_data' })
      expect(status.remainingSeconds).toBeCloseTo(300, 0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a never-run schedule completely pending and logs no recovery', async () => {
    const { db, svc, rounds } = makeService()

    const recovery = await svc.rehydrate()

    expect(recovery.roundsRestored).toBe(0)
    expect(rounds.getSchedule().every((r) => r.status === 'pending')).toBe(true)
    expect(db.rows('event_log')).toHaveLength(0) // nothing to restore -> no warning
    expect((await svc.startRound(0)).id).toBe('mock-1')
  })

  it('logs server_recovered once there is history to reconcile', async () => {
    const { db, svc } = makeService({
      rounds: [roundRow({ id: 'mock-1', index: 0, status: 'ended' })],
    })

    await svc.rehydrate()

    const recovered = db.rows('event_log').filter((e) => e.event_type === 'server_recovered')
    expect(recovered).toHaveLength(1)
    expect(recovered[0].severity).toBe('warning')
    expect(recovered[0].payload).toMatchObject({ roundsRestored: 1 })
  })

  /**
   * Used to throw. Now that the Master can extend the schedule by starting past
   * its end, a round in the DB but not in the static config is the NORMAL result
   * of a restart — it is re-appended and restored rather than aborting the boot.
   */
  it('restores an active round that is not in the configured schedule', async () => {
    const { svc } = makeService({
      rounds: [roundRow({ id: 'real-99', index: 9, status: 'active', ended_at: null })],
    })
    await expect(svc.rehydrate()).resolves.toMatchObject({ roundsRestored: 1 })

    const status = svc.getRoundStatus()
    expect(status.active).toBe(true)
    expect(status.id).toBe('real-99')
    expect(svc.getSchedule().some((r) => r.id === 'real-99')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (c) Round history is never overwritten
// ---------------------------------------------------------------------------

describe('(c) startRound refuses to overwrite a persisted round', () => {
  const STARTED = '2026-08-05T08:14:30.000Z'
  const ENDED = '2026-08-05T08:21:16.000Z'

  function withFinishedMock1() {
    return makeService({
      rounds: [roundRow({ id: 'mock-1', index: 0, status: 'ended', started_at: STARTED, ended_at: ENDED })],
    })
  }

  it('rejects the start and leaves the stored timings intact', async () => {
    const { db, svc } = withFinishedMock1()

    // Deliberately skip rehydrate() to reproduce the out-of-sync state from the
    // audit, where the controller believed every round was still pending.
    await expect(svc.startRound(0)).rejects.toThrow(/refusing to start round mock-1/)

    expect(db.row('rounds', 'mock-1')).toMatchObject({
      status: 'ended',
      started_at: STARTED,
      ended_at: ENDED,
    })
  })

  it('leaves the controller untouched, so the correct round can still start after rehydrate', async () => {
    const { svc, rounds } = withFinishedMock1()

    await expect(svc.startRound(0)).rejects.toThrow()
    expect(rounds.getSchedule().map((r) => r.status)).toEqual(['pending', 'pending', 'pending'])

    await svc.rehydrate()
    expect((await svc.startRound(0)).id).toBe('real-1')
  })

  it('also refuses when the DB still has the round marked active', async () => {
    const { db, svc } = makeService({
      rounds: [roundRow({ id: 'mock-1', index: 0, status: 'active', started_at: STARTED, ended_at: null })],
    })

    await expect(svc.startRound(0)).rejects.toThrow(/already has it as 'active'/)
    expect(db.row('rounds', 'mock-1')?.started_at).toBe(STARTED)
  })

  it('writes a fresh round row normally when there is no history', async () => {
    const { db, svc } = makeService()

    const round = await svc.startRound(0)

    expect(round.id).toBe('mock-1')
    expect(db.row('rounds', 'mock-1')).toMatchObject({ id: 'mock-1', index: 0, status: 'active' })
    expect(db.rows('rounds')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// (d) Resting orders are swept at round end
// ---------------------------------------------------------------------------

describe('(d) ending a round sweeps the book', () => {
  /** An active round with two resting orders and one already-filled order. */
  function withRestingBook() {
    return makeService({
      rounds: [roundRow({ id: 'mock-1', index: 0, status: 'active', started_at: T0, ended_at: null })],
      orders: [
        restingOrder({ id: 'o-rest', status: 'active', qty: 10, remaining_qty: 10, price: 248.9 }),
        restingOrder({
          id: 'o-part',
          status: 'partially_filled',
          qty: 10,
          remaining_qty: 9,
          price: 220,
          created_at: '2026-08-06T10:00:01.000Z',
        }),
        restingOrder({ id: 'o-done', status: 'filled', qty: 5, remaining_qty: 0, price: 230 }),
      ],
    })
  }

  it('cancels active and partially-filled orders, releasing their reserved margin', async () => {
    const { db, svc } = withRestingBook()
    await svc.rehydrate()
    expect(svc.getReservedMarginInr(ACCT)).toBeGreaterThan(0)

    await svc.endRound(300)

    expect(db.row('orders', 'o-rest')?.status).toBe('cancelled')
    expect(db.row('orders', 'o-part')?.status).toBe('cancelled')
    expect(svc.getReservedMarginInr(ACCT)).toBe(0)
    // Nothing left resting on either side of the book.
    expect(svc.getDepth('AAPL')).toEqual({ bids: [], asks: [] })
  })

  it('leaves already-completed orders alone', async () => {
    const { db, svc } = withRestingBook()
    await svc.rehydrate()

    await svc.endRound(300)

    expect(db.row('orders', 'o-done')).toMatchObject({ status: 'filled', remaining_qty: 0 })
  })

  it('preserves the partially-filled remaining quantity on the cancelled order', async () => {
    const { db, svc } = withRestingBook()
    await svc.rehydrate()

    await svc.endRound(300)

    // The 1 lot that traded stays traded; only the unfilled 9 are withdrawn.
    expect(db.row('orders', 'o-part')).toMatchObject({ status: 'cancelled', remaining_qty: 9 })
  })

  it('reports the sweep size on the round_ended event', async () => {
    const { db, svc } = withRestingBook()
    await svc.rehydrate()

    await svc.endRound(300)

    expect(db.roundEndedPayloads()[0]).toMatchObject({ roundId: 'mock-1', ordersCancelled: 2 })
  })

  it('sweeps on an automatic end too, not just a Master end', async () => {
    vi.useFakeTimers()
    try {
      atSecondsAfterStart(0)
      const { db, svc } = withRestingBook()
      await svc.rehydrate()

      atSecondsAfterStart(300)
      const ended = await svc.maybeAutoEndRound()

      expect(ended?.id).toBe('mock-1')
      expect(db.row('orders', 'o-rest')?.status).toBe('cancelled')
      expect(db.roundEndedPayloads()[0]).toMatchObject({ auto: true, ordersCancelled: 2 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('is a clean no-op when nothing is resting', async () => {
    const { db, svc } = makeService({
      rounds: [roundRow({ id: 'mock-1', index: 0, status: 'active', started_at: T0, ended_at: null })],
    })
    await svc.rehydrate()

    await svc.endRound(300)

    expect(db.roundEndedPayloads()[0]).toMatchObject({ ordersCancelled: 0 })
    expect(db.row('rounds', 'mock-1')?.status).toBe('ended')
  })

  it('no order survives into the next round', async () => {
    const { db, svc } = withRestingBook()
    await svc.rehydrate()

    await svc.endRound(300)
    await svc.startRound(300) // real-1

    const stillWorking = db
      .rows('orders')
      .filter((o) => o.status === 'active' || o.status === 'partially_filled')
    expect(stillWorking).toEqual([])
    expect(svc.getReservedMarginInr(ACCT)).toBe(0)
  })
})
