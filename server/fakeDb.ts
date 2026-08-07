/**
 * In-memory Supabase stand-in covering the query shapes TradingService uses.
 *
 * Lifted verbatim from tradingService.cash.test.ts so a new suite can drive the
 * real service without a fourth copy. The three existing suites keep their local
 * copies untouched — this bug fix is not the moment to refactor green tests.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>

// ---------------------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------------------

export class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
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

export class FakeDb {
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
