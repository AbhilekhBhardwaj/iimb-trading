/**
 * TradingService — the thin server-side layer that wires the pure, in-memory
 * engine (MatchingEngine + RoundController) to Supabase so real actions persist.
 *
 * It is deliberately transport-agnostic: a later HTTP/WebSocket API (or the
 * terminal UI calling a server function) just constructs one of these and calls
 * placeOrder / cancelOrder / startRound / endRound. All writes go through the
 * service-role client, honouring the RLS design where clients can only SELECT
 * their own rows and never write directly.
 *
 * Margin gate (before matching): an order is rejected unless
 *   requiredMargin(order) <= startingCash + realizedPnL
 *                            − marginUsed(open positions)
 *                            − marginReserved(other resting orders)
 * Reserved margin is derived live from the account's active/partially-filled
 * orders (remainingQty · price / leverage), so it is always current — it grows
 * when an order rests and shrinks automatically as it fills or is cancelled.
 *
 * Recovery: engine + round + margin state live in memory, so on startup call
 * rehydrate() to restore them from the DB before accepting orders (see below).
 *
 * ID strategy: the engine's order id doubles as the DB orders.id (uuid); trades
 * get their own DB uuid; instruments are referenced by uuid (resolved from
 * ticker at startup); rounds use the engine's stable string id (rounds.id text).
 */

import {
  MatchingEngine,
  RoundController,
  applyLeveredFill,
  isLiquidatable,
  liquidationPrice,
  positionMargin,
  requiredMargin,
  xirr,
  type Depth,
  type LeveredPosition,
  type Order,
  type OrderType,
  type Round,
  type RoundMode,
  type Side,
  type Trade,
} from '@iimb-trading/engine'
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { COMMISSION_RATE, MAINTENANCE_MARGIN_RATE } from './config'
import { usdInr } from './rate'

type Severity = 'info' | 'warning' | 'error'
const EPS = 1e-9

export interface PlaceOrderInput {
  /** profiles.id / auth user uuid of the account placing the order. */
  accountId: string
  /** Instrument ticker, e.g. 'AAPL'. */
  ticker: string
  side: Side
  type: OrderType
  /** Required for limit orders; ignored for market. */
  price?: number
  qty: number
  /** Chosen leverage (>= 1). Defaults to 1 (no leverage). */
  leverage?: number
  /** Reference price for valuing a MARKET order's margin (limit orders use price). */
  markPrice?: number
}

export interface PlaceOrderResult {
  accepted: boolean
  /** Present when the order was rejected before matching. */
  reason?: string
  orderId?: string
  status?: Order['status']
  remainingQty?: number
  trades?: Trade[]
}

/** A position enriched with its margin usage and liquidation price. */
export interface PositionView {
  ticker: string
  qty: number
  avgPrice: number
  leverage: number
  marginUsedInr: number
  liquidationPrice: number | null
}

/** An account's buying-power snapshot (cash figures in INR). */
export interface AccountState {
  startingCashInr: number
  realizedPnlInr: number
  marginUsedInr: number
  /** Margin locked up by the account's resting (unfilled) orders. */
  marginReservedInr: number
  /** startingCash + realizedPnL − marginUsed − marginReserved. Excludes unrealized P&L. */
  availableMarginInr: number
  positions: PositionView[]
}

export interface RecoveryResult {
  roundsRestored: number
  ordersRestored: number
  accountsWithPnl: number
  accountsWithReservations: number
}

export class TradingService {
  private readonly engine = new MatchingEngine()
  /** Every Order we've created/restored, by id — the engine mutates these. */
  private readonly orders = new Map<string, Order>()
  /** orderId -> chosen leverage (the engine Order type doesn't carry leverage). */
  private readonly orderLeverage = new Map<string, number>()
  /** accountId -> running realized P&L in USD (mirrors profiles.realized_pnl). */
  private readonly realizedPnlUsd = new Map<string, number>()
  /** ticker -> instruments.id (uuid) and the reverse. */
  private tickerToId = new Map<string, string>()
  private idToTicker = new Map<string, string>()
  /** ticker -> instrument metadata (name/sector/reference price). */
  private instrumentMeta = new Map<string, { name: string; sector: string; referencePrice: number }>()
  /** ticker -> most recent trade price (seeded from reference_price). */
  private lastPrice = new Map<string, number>()
  /** Monotonic time-priority counter handed to the engine (lower = earlier). */
  private seq = 0
  /** Round id currently persisted as active, used as the FK on new orders. */
  private activeRoundId: string | null = null
  /** Current event-clock second, passed to RoundController on start/end. */
  private nowSeconds = 0
  /** Wall-clock anchors for the active round's remaining-time countdown. */
  private roundStartedAtMs: number | null = null
  private roundDurationSeconds = 0

  constructor(
    private readonly db: SupabaseClient,
    private readonly rounds: RoundController,
  ) {}

  /** Load instrument maps + metadata + baseline prices. Call once before use. */
  async loadInstruments(): Promise<void> {
    const { data, error } = await this.db
      .from('instruments')
      .select('id, ticker, name, sector, reference_price')
    if (error) throw error
    this.tickerToId = new Map((data ?? []).map((r) => [r.ticker as string, r.id as string]))
    this.idToTicker = new Map((data ?? []).map((r) => [r.id as string, r.ticker as string]))
    this.instrumentMeta = new Map(
      (data ?? []).map((r) => [
        r.ticker as string,
        { name: r.name as string, sector: (r.sector as string) ?? '', referencePrice: Number(r.reference_price) },
      ]),
    )
    // Seed last price with the baseline; real trades overwrite it as they occur.
    for (const [ticker, meta] of this.instrumentMeta) {
      if (!this.lastPrice.has(ticker)) this.lastPrice.set(ticker, meta.referencePrice)
    }
  }

  // -------------------------------------------------------------------------
  // Recovery / rehydration
  // -------------------------------------------------------------------------

  /**
   * Restore in-memory state from the DB after a restart, BEFORE accepting orders:
   *   - the 'active' round into RoundController (with correct remaining time),
   *   - all 'active'/'partially_filled' orders onto the engine's books (resting,
   *     no re-matching), which also rebuilds reserved-margin tracking,
   *   - each account's realized P&L into memory.
   * Logs 'server_recovered' (warning) with counts. No-op (and no log) if there
   * is nothing to restore.
   */
  async rehydrate(): Promise<RecoveryResult> {
    if (this.tickerToId.size === 0) await this.loadInstruments()

    const roundsRestored = await this.restoreActiveRound()
    const { ordersRestored, accountsWithReservations } = await this.restoreOpenOrders()
    const accountsWithPnl = await this.restoreRealizedPnl()
    // Restore each instrument's mark to its last traded price BEFORE the no-op
    // check — a position can exist with zero realized P&L, and it must still be
    // marked to the real last trade (not the reference seed) after a restart.
    await this.restoreMarks()

    const result: RecoveryResult = {
      roundsRestored,
      ordersRestored,
      accountsWithPnl,
      accountsWithReservations,
    }

    if (roundsRestored === 0 && ordersRestored === 0 && accountsWithPnl === 0) {
      return result // nothing to restore → no-op, no log
    }
    await this.log(null, 'server_recovered', 'warning', { ...result })
    return result
  }

  /**
   * Restore each instrument's mark to its MOST RECENT traded price from the DB,
   * so a restart marks open positions to the true last trade (matching the live
   * process) instead of the static reference-price seed. Without this, a
   * restart would silently re-value every open position against a stale seed
   * price. Instruments that have never traded keep their reference-price seed.
   */
  private async restoreMarks(): Promise<number> {
    const { data, error } = await this.db
      .from('trades')
      .select('instrument_id, price, created_at')
      .order('created_at', { ascending: false })
    if (error) throw error
    const seen = new Set<string>()
    let restored = 0
    for (const row of data ?? []) {
      const id = row.instrument_id as string
      if (seen.has(id)) continue // first row per instrument = its most recent trade
      seen.add(id)
      const ticker = this.idToTicker.get(id)
      if (!ticker) continue
      this.lastPrice.set(ticker, Number(row.price))
      restored++
    }
    return restored
  }

  private async restoreActiveRound(): Promise<number> {
    const { data, error } = await this.db.from('rounds').select('*').order('index')
    if (error) throw error
    const active = (data ?? []).find((r) => r.status === 'active')
    if (!active) return 0

    // Drive the injected controller to the active round: burn earlier rounds,
    // then start the target at a negative offset so its remaining time equals
    // duration − elapsed (with the service clock pinned at 0).
    const schedule = this.rounds.getSchedule()
    const targetIdx = schedule.findIndex((r) => r.id === active.id)
    if (targetIdx < 0) throw new Error(`active round ${active.id} not in RoundController config`)

    for (let i = 0; i < targetIdx; i++) {
      this.rounds.startNextRound(0)
      this.rounds.endCurrentRound(0)
    }
    this.rounds.startNextRound(0) // make it the active round for getMode() gating
    this.nowSeconds = 0
    this.activeRoundId = active.id as string
    // Remaining time is computed from the wall-clock start + duration.
    this.roundStartedAtMs = Date.parse(active.started_at as string)
    this.roundDurationSeconds = Number(active.duration_seconds)
    return 1
  }

  private async restoreOpenOrders(): Promise<{ ordersRestored: number; accountsWithReservations: number }> {
    const { data, error } = await this.db
      .from('orders')
      .select('id, account_id, instrument_id, side, type, price, qty, remaining_qty, status, leverage')
      .in('status', ['active', 'partially_filled'])
      .order('created_at', { ascending: true })
    if (error) throw error

    const accounts = new Set<string>()
    for (const row of data ?? []) {
      const ticker = this.idToTicker.get(row.instrument_id as string)
      if (!ticker || row.type !== 'limit' || row.price === null) continue // market orders never rest
      const order: Order = {
        id: row.id as string,
        userId: row.account_id as string,
        instrument: ticker,
        side: row.side as Side,
        type: 'limit',
        price: Number(row.price),
        qty: Number(row.qty),
        remainingQty: Number(row.remaining_qty),
        status: row.status as Order['status'],
        timestamp: this.seq++, // preserve DB (created_at) order as time priority
      }
      this.orders.set(order.id, order)
      this.orderLeverage.set(order.id, Number(row.leverage))
      this.engine.restResting(order)
      accounts.add(order.userId)
    }
    return { ordersRestored: this.orders.size, accountsWithReservations: accounts.size }
  }

  private async restoreRealizedPnl(): Promise<number> {
    const { data, error } = await this.db.from('profiles').select('id, realized_pnl').neq('realized_pnl', 0)
    if (error) throw error
    for (const row of data ?? []) {
      this.realizedPnlUsd.set(row.id as string, Number(row.realized_pnl))
    }
    return (data ?? []).length
  }

  // -------------------------------------------------------------------------
  // Rounds
  // -------------------------------------------------------------------------

  async startRound(atSecond: number): Promise<Round> {
    const round = this.rounds.startNextRound(atSecond)
    this.activeRoundId = round.id
    this.nowSeconds = atSecond
    this.roundStartedAtMs = Date.now()
    this.roundDurationSeconds = round.durationSeconds

    const { error } = await this.db.from('rounds').upsert(
      {
        id: round.id,
        index: round.index,
        mode: round.mode,
        duration_seconds: round.durationSeconds,
        commission_enabled: round.commissionEnabled,
        status: 'active',
        started_at: new Date().toISOString(),
        ended_at: null,
      },
      { onConflict: 'id' },
    )
    if (error) throw error

    await this.log(null, 'round_started', 'info', {
      roundId: round.id,
      index: round.index,
      mode: round.mode,
    })
    return round
  }

  async endRound(atSecond: number): Promise<Round> {
    const round = this.rounds.endCurrentRound(atSecond)
    this.nowSeconds = atSecond
    const { error } = await this.db
      .from('rounds')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', round.id)
    if (error) throw error

    if (this.activeRoundId === round.id) {
      this.activeRoundId = null
      this.roundStartedAtMs = null
    }
    await this.log(null, 'round_ended', 'info', { roundId: round.id, index: round.index })
    return round
  }

  /** Remaining seconds in the active round (wall-clock from started_at + duration), or null. */
  getRoundRemainingSeconds(): number | null {
    if (this.activeRoundId === null || this.roundStartedAtMs === null) return null
    return Math.max(0, this.roundDurationSeconds - (Date.now() - this.roundStartedAtMs) / 1000)
  }

  /** Full round status for the terminal's status bar. */
  getRoundStatus(): {
    active: boolean
    id: string | null
    index: number | null
    mode: RoundMode | null
    commissionEnabled: boolean
    remainingSeconds: number | null
  } {
    const cur = this.activeRoundId === null ? null : this.rounds.getCurrentRound()
    return {
      active: cur !== null,
      id: cur?.id ?? null,
      index: cur?.index ?? null,
      mode: cur?.mode ?? null,
      commissionEnabled: cur?.commissionEnabled ?? false,
      remainingSeconds: this.getRoundRemainingSeconds(),
    }
  }

  /** Full ordered schedule (all rounds, statuses, modes, commission) for the admin. */
  getSchedule(): Round[] {
    return this.rounds.getSchedule()
  }

  /**
   * Master control: set commission on the active round (or next pending if none
   * active). Persists to the DB only for the active round (pending rounds have no
   * row until started). NOTE: this flips/stores the flag and updates displays —
   * commission is not yet charged against trade P&L (separate follow-up).
   */
  async setCommission(enabled: boolean): Promise<Round | null> {
    const changed = this.rounds.setCommission(enabled)
    if (!changed) return null
    if (this.activeRoundId === changed.id) {
      const { error } = await this.db.from('rounds').update({ commission_enabled: enabled }).eq('id', changed.id)
      if (error) throw error
    }
    await this.log(null, 'commission_changed', 'info', { roundId: changed.id, enabled })
    return changed
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    // 1. Round gate — no active round means no trading.
    if (this.rounds.getMode() === null || this.activeRoundId === null) {
      return this.reject(input, 'no active round')
    }
    // 2. Instrument must be known.
    const instrumentId = this.tickerToId.get(input.ticker)
    if (!instrumentId) return this.reject(input, `unknown instrument: ${input.ticker}`)
    // 3. Basic validation.
    if (!(input.qty > 0)) return this.reject(input, 'qty must be positive')
    const leverage = input.leverage ?? 1
    if (!(leverage >= 1)) return this.reject(input, 'invalid_leverage')
    if (input.type === 'limit' && (input.price === undefined || Number.isNaN(input.price))) {
      return this.reject(input, 'limit order requires a price')
    }

    // 4. Margin / buying-power gate — BEFORE the matching engine. Value the order
    // at its limit price (market orders use a supplied mark). Available margin
    // subtracts BOTH open positions AND margin reserved by other resting orders.
    const valuationPrice =
      input.type === 'limit' ? (input.price as number) : (input.markPrice ?? this.lastPrice.get(input.ticker))
    if (valuationPrice === undefined || !(valuationPrice > 0)) {
      return this.reject(input, 'no_reference_price')
    }
    const existing = await this.leveredPosition(input.accountId, instrumentId)
    const signedQty = input.side === 'buy' ? input.qty : -input.qty
    const requiredUsd = requiredMargin(existing, signedQty, valuationPrice, leverage)
    const availableUsd = await this.availableMarginUsd(input.accountId)
    if (requiredUsd > availableUsd + EPS) {
      return this.reject(input, 'insufficient_margin', {
        requiredMarginInr: requiredUsd * usdInr(),
        availableMarginInr: availableUsd * usdInr(),
        leverage,
      })
    }

    const roundId = this.activeRoundId

    // 5. Build the engine order; its id is also the DB row's uuid pk.
    const order: Order = {
      id: randomUUID(),
      userId: input.accountId,
      instrument: input.ticker,
      side: input.side,
      type: input.type,
      price: input.type === 'limit' ? input.price : undefined,
      qty: input.qty,
      remainingQty: input.qty,
      status: 'active',
      timestamp: this.seq++,
    }
    this.orders.set(order.id, order)
    this.orderLeverage.set(order.id, leverage)

    // 6. Persist as 'active' BEFORE matching, so any resulting trades can FK it.
    const { error: insErr } = await this.db.from('orders').insert({
      id: order.id,
      account_id: order.userId,
      instrument_id: instrumentId,
      round_id: roundId,
      side: order.side,
      type: order.type,
      price: order.type === 'limit' ? order.price : null,
      qty: order.qty,
      remaining_qty: order.qty,
      status: 'active',
      leverage,
    })
    if (insErr) throw insErr
    await this.log(order.userId, 'order_placed', 'info', {
      orderId: order.id,
      instrument: order.instrument,
      side: order.side,
      type: order.type,
      price: order.price ?? null,
      qty: order.qty,
      leverage,
      roundId,
    })

    // 7. Match.
    const trades =
      order.type === 'limit'
        ? this.engine.placeLimitOrder(order)
        : this.engine.placeMarketOrder(order)

    // 8. Persist every resulting trade + both sides' positions. The taker (this
    // order) is the aggressor, which drives the Times & Sales Buy/Sell column.
    for (const trade of trades) await this.persistTrade(trade, instrumentId, roundId, order.side)

    // 9. Sync the taker and every matched maker's status/remaining to the DB.
    const affected = new Set<string>([order.id])
    for (const t of trades) {
      affected.add(t.buyOrderId)
      affected.add(t.sellOrderId)
    }
    for (const id of affected) await this.syncOrderState(id)

    return {
      accepted: true,
      orderId: order.id,
      status: order.status,
      remainingQty: order.remainingQty,
      trades,
    }
  }

  /**
   * Cancel a resting order and persist the 'cancelled' status (releasing its
   * reserved margin). When `requester` is given, a non-master may only cancel
   * their own order.
   */
  async cancelOrder(
    orderId: string,
    requester?: { accountId: string; role: string },
  ): Promise<boolean> {
    if (requester && requester.role !== 'master') {
      const owner = this.orders.get(orderId)
      if (owner && owner.userId !== requester.accountId) return false
    }
    if (!this.engine.cancelOrder(orderId)) return false
    await this.syncOrderState(orderId)
    return true
  }

  // -------------------------------------------------------------------------
  // Account / margin views
  // -------------------------------------------------------------------------

  /** Buying-power snapshot for an account (cash figures in INR). */
  async getAccountState(accountId: string): Promise<AccountState> {
    const startingCashInr = await this.startingCashInr(accountId)
    const positions = await this.positionViews(accountId)
    const marginUsedInr = positions.reduce((a, p) => a + p.marginUsedInr, 0)
    const marginReservedInr = this.reservedMarginUsd(accountId) * usdInr()
    const realizedPnlInr = (this.realizedPnlUsd.get(accountId) ?? 0) * usdInr()
    return {
      startingCashInr,
      realizedPnlInr,
      marginUsedInr,
      marginReservedInr,
      availableMarginInr: startingCashInr + realizedPnlInr - marginUsedInr - marginReservedInr,
      positions,
    }
  }

  /** Margin (INR) currently locked up by an account's resting orders. */
  getReservedMarginInr(accountId: string): number {
    return this.reservedMarginUsd(accountId) * usdInr()
  }

  /** Depth ladder for an instrument (proxy to the engine) — useful for recovery checks. */
  getDepth(ticker: string): Depth {
    return this.engine.getDepth(ticker)
  }

  /** Liquidation price for one open position (USD), or null if flat/none. */
  async getLiquidationPrice(accountId: string, ticker: string): Promise<number | null> {
    const instrumentId = this.tickerToId.get(ticker)
    if (!instrumentId) return null
    return liquidationPrice(await this.leveredPosition(accountId, instrumentId), MAINTENANCE_MARGIN_RATE)
  }

  /** Whether an account's position in `ticker` is liquidatable at `markPrice` (USD). */
  async isPositionLiquidatable(accountId: string, ticker: string, markPrice: number): Promise<boolean> {
    const instrumentId = this.tickerToId.get(ticker)
    if (!instrumentId) return false
    return isLiquidatable(await this.leveredPosition(accountId, instrumentId), markPrice, MAINTENANCE_MARGIN_RATE)
  }

  // -------------------------------------------------------------------------
  // Terminal read-side (drives the HTTP API)
  // -------------------------------------------------------------------------

  /** Static instrument catalogue (ticker/name/sector/baseline) for bootstrap. */
  instrumentCatalogue(): { ticker: string; name: string; sector: string; referencePrice: number }[] {
    return [...this.instrumentMeta].map(([ticker, m]) => ({ ticker, ...m }))
  }

  /** Instrument list with live LTP and the caller's position, for the left panel. */
  async instrumentsWithPositions(accountId: string): Promise<
    {
      ticker: string
      name: string
      sector: string
      ltp: number
      position: PositionView | null
    }[]
  > {
    const byTicker = new Map((await this.positionViews(accountId)).map((p) => [p.ticker, p]))
    return [...this.instrumentMeta].map(([ticker, m]) => ({
      ticker,
      name: m.name,
      sector: m.sector,
      ltp: this.lastPrice.get(ticker) ?? m.referencePrice,
      position: byTicker.get(ticker) ?? null,
    }))
  }

  /** LTP for a ticker (last trade, or baseline before any trade). */
  ltp(ticker: string): number {
    return this.lastPrice.get(ticker) ?? this.instrumentMeta.get(ticker)?.referencePrice ?? 0
  }

  /**
   * Depth ladder for an instrument (zero-qty levels already excluded by the
   * engine's aggregation). When `includeResting` (market makers), also returns
   * the individual resting orders for full liquidity visibility.
   */
  depthView(
    ticker: string,
    includeResting: boolean,
  ): {
    bids: Depth['bids']
    asks: Depth['asks']
    restingOrders?: { orderId: string; accountId: string; side: Side; price: number; remainingQty: number; leverage: number }[]
  } {
    const depth = this.engine.getDepth(ticker)
    if (!includeResting) return { bids: depth.bids, asks: depth.asks }
    const restingOrders: { orderId: string; accountId: string; side: Side; price: number; remainingQty: number; leverage: number }[] = []
    for (const o of this.orders.values()) {
      if (o.instrument !== ticker || o.price === undefined) continue
      if (o.status !== 'active' && o.status !== 'partially_filled') continue
      restingOrders.push({
        orderId: o.id,
        accountId: o.userId,
        side: o.side,
        price: o.price,
        remainingQty: o.remainingQty,
        leverage: this.orderLeverage.get(o.id) ?? 1,
      })
    }
    restingOrders.sort((a, b) => b.price - a.price)
    return { bids: depth.bids, asks: depth.asks, restingOrders }
  }

  /** Recent trades for an instrument (Times & Sales tape), newest first. */
  async recentTrades(
    ticker: string,
    limit = 50,
  ): Promise<{ id: string; t: number; price: number; qty: number; side: Side | null }[]> {
    const instrumentId = this.tickerToId.get(ticker)
    if (!instrumentId) return []
    const { data, error } = await this.db
      .from('trades')
      .select('id, price, qty, aggressor, created_at')
      .eq('instrument_id', instrumentId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return (data ?? []).map((r) => ({
      id: r.id as string,
      t: Date.parse(r.created_at as string),
      price: Number(r.price),
      qty: Number(r.qty),
      side: (r.aggressor as Side | null) ?? null,
    }))
  }

  /**
   * Trade series (price + qty) within a window, for building candles + volume.
   * Returns a flat baseline point (qty 0) when the instrument is untraded, so the
   * chart can still render a starting candle.
   */
  async priceHistory(ticker: string, windowSeconds = 600): Promise<{ t: number; price: number; qty: number }[]> {
    const instrumentId = this.tickerToId.get(ticker)
    const baseline = this.ltp(ticker)
    const now = Date.now()
    if (!instrumentId) return [{ t: now, price: baseline, qty: 0 }]
    const sinceIso = new Date(now - windowSeconds * 1000).toISOString()
    const { data, error } = await this.db
      .from('trades')
      .select('price, qty, created_at')
      .eq('instrument_id', instrumentId)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true })
    if (error) throw error
    const points = (data ?? []).map((r) => ({
      t: Date.parse(r.created_at as string),
      price: Number(r.price),
      qty: Number(r.qty),
    }))
    return points.length === 0 ? [{ t: now, price: baseline, qty: 0 }] : points
  }

  /** Recent event-wide notifications for the strip + announcement popups. */
  async notifications(
    limit = 30,
  ): Promise<{ id: string; kind: string; title: string; body: string | null; roundId: string | null; t: number }[]> {
    const { data, error } = await this.db
      .from('notifications')
      .select('id, kind, title, body, round_id, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return (data ?? []).map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      title: r.title as string,
      body: (r.body as string | null) ?? null,
      roundId: (r.round_id as string | null) ?? null,
      t: Date.parse(r.created_at as string),
    }))
  }

  /** The caller's own resting orders for an instrument (for the working-orders list + cancel). */
  myRestingOrders(
    accountId: string,
    ticker: string,
  ): { orderId: string; side: Side; price: number; qty: number; remainingQty: number; status: Order['status']; leverage: number }[] {
    const out: { orderId: string; side: Side; price: number; qty: number; remainingQty: number; status: Order['status']; leverage: number }[] = []
    for (const o of this.orders.values()) {
      if (o.userId !== accountId || o.instrument !== ticker || o.price === undefined) continue
      if (o.status !== 'active' && o.status !== 'partially_filled') continue
      out.push({
        orderId: o.id,
        side: o.side,
        price: o.price,
        qty: o.qty,
        remainingQty: o.remainingQty,
        status: o.status,
        leverage: this.orderLeverage.get(o.id) ?? 1,
      })
    }
    return out.sort((a, b) => b.price - a.price)
  }

  /** Publish an event-wide notification (Master Terminal / testing). */
  async publishNotification(kind: string, title: string, body?: string): Promise<void> {
    // Tagged with the active round so the News page can archive Daily News per round.
    const { error } = await this.db
      .from('notifications')
      .insert({ kind, title, body: body ?? null, round_id: this.activeRoundId })
    if (error) throw error
  }

  /** Everything the terminal needs for one poll tick, for the selected instrument. */
  async snapshot(
    accountId: string,
    role: string,
    ticker: string | null,
    priceWindowSeconds = 600,
  ): Promise<Record<string, unknown>> {
    const [account, instruments, trades, prices, notifications] = await Promise.all([
      this.getAccountState(accountId),
      this.instrumentsWithPositions(accountId),
      ticker ? this.recentTrades(ticker, 50) : Promise.resolve([]),
      ticker ? this.priceHistory(ticker, priceWindowSeconds) : Promise.resolve([]),
      this.notifications(30),
    ])
    return {
      round: this.getRoundStatus(),
      account,
      instruments,
      depth: ticker ? this.depthView(ticker, role === 'market_maker') : null,
      myOrders: ticker ? this.myRestingOrders(accountId, ticker) : [],
      trades,
      prices,
      notifications,
      rate: usdInr(),
      serverTime: Date.now(),
    }
  }

  /** Event start (earliest round start) in epoch ms, or null before any round. */
  private async eventStartMs(): Promise<number | null> {
    const { data, error } = await this.db
      .from('rounds')
      .select('started_at')
      .not('started_at', 'is', null)
      .order('started_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    return data?.started_at ? Date.parse(data.started_at as string) : null
  }

  /** Everything the Portfolio page needs. Cash figures in INR at the live rate. */
  async portfolio(accountId: string): Promise<Record<string, unknown>> {
    const rate = usdInr()
    const realizedPnlUsd = this.realizedPnlUsd.get(accountId) ?? 0
    const realizedPnlInr = realizedPnlUsd * rate

    // These four reads are INDEPENDENT — run them concurrently. Each is a remote
    // Supabase round-trip (~180ms); done serially they were this endpoint's
    // dominant cost (~4× latency ≈ 0.75s). One round-trip's worth now.
    const [openingBalanceInr, positionsRes, t0, tradeHistory] = await Promise.all([
      this.startingCashInr(accountId),
      this.db.from('positions').select('instrument_id, qty, avg_price, leverage').eq('account_id', accountId),
      this.eventStartMs(),
      this.tradeHistory(accountId),
    ])
    if (positionsRes.error) throw positionsRes.error
    const data = positionsRes.data
    const cashInr = openingBalanceInr + realizedPnlInr
    const posByTicker = new Map(
      (data ?? []).map((p) => [this.idToTicker.get(p.instrument_id as string) ?? '', p]),
    )

    let openPositions = 0
    let levNotionalUsd = 0 // entry notional, for the weighted-average leverage
    let levMarginUsd = 0
    const inventory = [...this.instrumentMeta].map(([ticker, meta], i) => {
      const p = posByTicker.get(ticker)
      const ltp = this.lastPrice.get(ticker) ?? meta.referencePrice
      const qty = p ? Number(p.qty) : 0
      if (qty === 0) {
        return {
          index: i + 1, ticker, name: meta.name, ltp,
          qty: null, leverage: null, avgPrice: null,
          avgEntryInr: null, currentPriceInr: null,
          pnlM2mInr: null, portfolioValueInr: null, costBasisInr: null,
        }
      }
      openPositions++
      const avgPrice = Number(p!.avg_price)
      const leverage = Number(p!.leverage)
      levNotionalUsd += Math.abs(qty) * avgPrice
      levMarginUsd += (Math.abs(qty) * avgPrice) / leverage
      return {
        index: i + 1, ticker, name: meta.name, ltp,
        qty, leverage, avgPrice,
        avgEntryInr: avgPrice * rate, // prices converted server-side; the rate is never exposed to the UI
        currentPriceInr: ltp * rate,
        pnlM2mInr: qty * (ltp - avgPrice) * rate, // mark-to-market unrealized
        portfolioValueInr: qty * ltp * rate,
        costBasisInr: qty * avgPrice * rate,
      }
    })
    // Effective portfolio leverage: total notional / total margin posted (1× flat).
    const leverageReq = levMarginUsd > 0 ? levNotionalUsd / levMarginUsd : 1

    const positionsValueInr = inventory.reduce((s, r) => s + (r.portfolioValueInr ?? 0), 0)
    const unrealizedPnlInr = inventory.reduce((s, r) => s + (r.pnlM2mInr ?? 0), 0)
    // Equity = cash + unrealized P&L (internally consistent: equals opening + total P&L).
    const totalPortfolioValueInr = cashInr + unrealizedPnlInr
    const totalPnlInr = realizedPnlInr + unrealizedPnlInr
    const totalPnlPct = openingBalanceInr > 0 ? (totalPnlInr / openingBalanceInr) * 100 : 0

    // XIRR: starting capital out at event start, current total value in as of now.
    // t0 was fetched concurrently above.
    const xirrValue =
      t0 === null
        ? null
        : xirr([
            { amount: -openingBalanceInr, when: t0 },
            { amount: totalPortfolioValueInr, when: Date.now() },
          ])

    return {
      rate,
      openingBalanceInr,
      realizedPnlUsd,
      realizedPnlInr,
      cashInr,
      inventory,
      positionsValueInr,
      unrealizedPnlInr,
      totalPnlInr,
      totalPnlPct,
      totalPortfolioValueInr,
      xirr: xirrValue,
      // Effective portfolio leverage (weighted average of open positions; 1× flat).
      leverageReq,
      openPositions,
      chargesInr: 0, // commission not applied yet (rounds may enable it later)
      tradeHistory, // fetched concurrently above
    }
  }

  /** Admin-only overview of every team: equity + total P&L (same equity math as the portfolio). */
  async teamsOverview(): Promise<
    { username: string; teamName: string | null; equityInr: number; totalPnlInr: number; totalPnlPct: number; openPositions: number }[]
  > {
    const rate = usdInr()
    const { data: profs, error: pErr } = await this.db
      .from('profiles')
      .select('id, username, team_name, starting_cash, realized_pnl')
      .eq('role', 'team')
      .order('username')
    if (pErr) throw pErr

    const { data: allPos, error: posErr } = await this.db
      .from('positions')
      .select('account_id, instrument_id, qty, avg_price')
    if (posErr) throw posErr
    const byAccount = new Map<string, { instrument_id: string; qty: number; avg: number }[]>()
    for (const p of allPos ?? []) {
      const arr = byAccount.get(p.account_id as string) ?? []
      arr.push({ instrument_id: p.instrument_id as string, qty: Number(p.qty), avg: Number(p.avg_price) })
      byAccount.set(p.account_id as string, arr)
    }

    return (profs ?? []).map((pr) => {
      const positions = byAccount.get(pr.id as string) ?? []
      let unrealizedUsd = 0
      let openPositions = 0
      for (const pos of positions) {
        if (pos.qty === 0) continue
        openPositions++
        const ticker = this.idToTicker.get(pos.instrument_id) ?? ''
        const ltp = this.lastPrice.get(ticker) ?? 0
        unrealizedUsd += pos.qty * (ltp - pos.avg)
      }
      const realizedUsd = this.realizedPnlUsd.get(pr.id as string) ?? Number(pr.realized_pnl)
      const openingInr = Number(pr.starting_cash)
      const totalPnlInr = (realizedUsd + unrealizedUsd) * rate
      return {
        username: pr.username as string,
        teamName: (pr.team_name as string | null) ?? null,
        equityInr: openingInr + totalPnlInr,
        totalPnlInr,
        totalPnlPct: openingInr > 0 ? (totalPnlInr / openingInr) * 100 : 0,
        openPositions,
      }
    })
  }

  /**
   * Public leaderboard: every TEAM ranked by equity (Total Portfolio Value),
   * highest first. Reuses teamsOverview() so the equity math is defined exactly
   * once (same as the portfolio page); master/market_maker are already excluded
   * there via the role='team' filter. Ties break by username for a stable order.
   */
  async leaderboard(): Promise<
    { rank: number; username: string; teamName: string | null; equityInr: number; totalPnlInr: number; totalPnlPct: number }[]
  > {
    const teams = await this.teamsOverview()
    return teams
      .sort((a, b) => b.equityInr - a.equityInr || a.username.localeCompare(b.username))
      .map((t, i) => ({
        rank: i + 1,
        username: t.username,
        teamName: t.teamName,
        equityInr: t.equityInr,
        totalPnlInr: t.totalPnlInr,
        totalPnlPct: t.totalPnlPct,
      }))
  }

  /**
   * Per-trade realized P&L for an account, reconstructed from the `trades` table.
   * We replay the account's fills in time order through the same position math the
   * engine uses; every fill that closes/reduces/flips a position emits one closed-
   * trade record (entry = avg before the fill, exit = fill price, realized = the
   * amount locked in). Most recent first. Amounts in INR at the live rate.
   */
  async tradeHistory(
    accountId: string,
  ): Promise<{ ticker: string; side: 'long' | 'short'; entryPriceInr: number; exitPriceInr: number; qty: number; grossPnlInr: number; commissionInr: number; realizedPnlInr: number; closedAt: number }[]> {
    const rate = usdInr()
    const { data: myOrders, error: oErr } = await this.db.from('orders').select('id').eq('account_id', accountId)
    if (oErr) throw oErr
    const ids = (myOrders ?? []).map((o) => o.id as string)
    if (ids.length === 0) return []
    const idSet = new Set(ids)
    const inList = `(${ids.join(',')})`

    // Which rounds had commission on — to reconstruct charges per closing fill.
    const { data: roundRows } = await this.db.from('rounds').select('id, commission_enabled')
    const commissionByRound = new Map((roundRows ?? []).map((r) => [r.id as string, r.commission_enabled as boolean]))

    const { data: trades, error: tErr } = await this.db
      .from('trades')
      .select('price, qty, created_at, instrument_id, round_id, buy_order_id, sell_order_id')
      .or(`buy_order_id.in.${inList},sell_order_id.in.${inList}`)
      .order('created_at', { ascending: true })
    if (tErr) throw tErr

    const pos = new Map<string, { qty: number; avgPrice: number }>()
    const history: { ticker: string; side: 'long' | 'short'; entryPriceInr: number; exitPriceInr: number; qty: number; grossPnlInr: number; commissionInr: number; realizedPnlInr: number; closedAt: number }[] = []
    for (const t of trades ?? []) {
      const isBuyer = idSet.has(t.buy_order_id as string)
      const isSeller = idSet.has(t.sell_order_id as string)
      if (isBuyer === isSeller) continue // both (self-trade) or neither → net zero for this account
      const price = Number(t.price)
      const signed = isBuyer ? Number(t.qty) : -Number(t.qty)
      const ticker = this.idToTicker.get(t.instrument_id as string) ?? (t.instrument_id as string)
      const cur = pos.get(ticker) ?? { qty: 0, avgPrice: 0 }
      const next = applyLeveredFill({ qty: cur.qty, avgPrice: cur.avgPrice, leverage: 1 }, signed, price, 1)
      if (next.realizedPnl !== 0) {
        const closedQty = Math.min(Math.abs(signed), Math.abs(cur.qty))
        // Commission on the closing portion of this fill, if that round charged it.
        const commissionUsd = commissionByRound.get(t.round_id as string) ? COMMISSION_RATE * closedQty * price : 0
        const gross = next.realizedPnl
        history.push({
          ticker,
          side: cur.qty > 0 ? 'long' : 'short', // the position that was closed/reduced
          entryPriceInr: cur.avgPrice * rate,
          exitPriceInr: price * rate,
          qty: closedQty,
          grossPnlInr: gross * rate,
          commissionInr: commissionUsd * rate,
          realizedPnlInr: (gross - commissionUsd) * rate, // net: Sell − Charges
          closedAt: Date.parse(t.created_at as string),
        })
      }
      pos.set(ticker, { qty: next.qty, avgPrice: next.avgPrice })
    }
    return history.reverse() // most recent first
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async persistTrade(
    trade: Trade,
    instrumentId: string,
    roundId: string,
    aggressor: Side,
  ): Promise<void> {
    const buyer = this.orders.get(trade.buyOrderId)
    const seller = this.orders.get(trade.sellOrderId)
    if (!buyer || !seller) throw new Error(`trade ${trade.id} references an unknown order`)

    // Track the last-trade price that feeds LTP / charts / market-order valuation.
    this.lastPrice.set(buyer.instrument, trade.price)

    // DB assigns the trade's own uuid pk; the engine trade id is not stored.
    const { error: tErr } = await this.db.from('trades').insert({
      buy_order_id: trade.buyOrderId,
      sell_order_id: trade.sellOrderId,
      instrument_id: instrumentId,
      round_id: roundId,
      price: trade.price,
      qty: trade.qty,
      aggressor,
    })
    if (tErr) throw tErr

    // Commission: charged to BOTH sides as a % of notional (qty × price), but
    // only while the active round has commission enabled. It's a cost, so it is
    // deducted from each account's realized P&L at the time of the fill.
    const commissionUsd = this.rounds.isCommissionActive() ? COMMISSION_RATE * trade.qty * trade.price : 0

    // Buyer gains qty, seller loses qty — each valued at the execution price and
    // using ITS OWN order's leverage (matters only when the fill opens/flips).
    await this.applyPosition(buyer.userId, instrumentId, trade.qty, trade.price, this.orderLeverage.get(buyer.id) ?? 1, commissionUsd)
    await this.applyPosition(seller.userId, instrumentId, -trade.qty, trade.price, this.orderLeverage.get(seller.id) ?? 1, commissionUsd)

    const ticker = this.idToTicker.get(instrumentId) ?? instrumentId
    // One order_matched event per side so each account sees its own fill.
    const base = { instrument: ticker, price: trade.price, qty: trade.qty, buyOrderId: trade.buyOrderId, sellOrderId: trade.sellOrderId }
    await this.log(buyer.userId, 'order_matched', 'info', { ...base, side: 'buy' })
    await this.log(seller.userId, 'order_matched', 'info', { ...base, side: 'sell' })

    // Audit each side's commission.
    if (commissionUsd > 0) {
      const rate = usdInr()
      const audit = { instrument: ticker, qty: trade.qty, price: trade.price, notional: trade.qty * trade.price, commissionRate: COMMISSION_RATE, commissionUsd, commissionInr: commissionUsd * rate }
      await this.log(buyer.userId, 'commission_charged', 'info', { ...audit, side: 'buy' })
      await this.log(seller.userId, 'commission_charged', 'info', { ...audit, side: 'sell' })
    }
  }

  private async applyPosition(
    accountId: string,
    instrumentId: string,
    delta: number,
    price: number,
    fillLeverage: number,
    commissionUsd = 0,
  ): Promise<void> {
    const current = await this.leveredPosition(accountId, instrumentId)
    const next = applyLeveredFill(current, delta, price, fillLeverage)

    const { error: upErr } = await this.db.from('positions').upsert(
      {
        account_id: accountId,
        instrument_id: instrumentId,
        qty: next.qty,
        avg_price: next.avgPrice,
        leverage: next.leverage,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,instrument_id' },
    )
    if (upErr) throw upErr

    // Realized P&L (USD, locked) net of commission: position P&L on this fill
    // minus the commission charged for it. Commission alone moves realized even
    // on an opening fill (position P&L 0). Absolute running total — this process
    // is the single authoritative writer.
    const netRealizedUsd = next.realizedPnl - commissionUsd
    if (netRealizedUsd !== 0) {
      const totalUsd = (this.realizedPnlUsd.get(accountId) ?? 0) + netRealizedUsd
      this.realizedPnlUsd.set(accountId, totalUsd)
      const { error: pnlErr } = await this.db
        .from('profiles')
        .update({ realized_pnl: totalUsd })
        .eq('id', accountId)
      if (pnlErr) throw pnlErr
    }
  }

  /**
   * Margin (USD) locked by an account's currently-resting orders. Derived live
   * from the in-memory order objects (which the engine mutates), so it reflects
   * partial fills and cancellations immediately. Each resting order reserves
   * remainingQty · price / leverage. `excludeOrderId` omits one order (unused at
   * placement, since the new order isn't resting yet).
   */
  private reservedMarginUsd(accountId: string, excludeOrderId?: string): number {
    let total = 0
    for (const o of this.orders.values()) {
      if (o.userId !== accountId || o.id === excludeOrderId) continue
      if (o.status !== 'active' && o.status !== 'partially_filled') continue
      if (o.price === undefined) continue // market orders never rest
      total += (o.remainingQty * o.price) / (this.orderLeverage.get(o.id) ?? 1)
    }
    return total
  }

  /** Current position (qty, avgPrice, leverage) for an account+instrument; flat if none. */
  private async leveredPosition(accountId: string, instrumentId: string): Promise<LeveredPosition> {
    const { data, error } = await this.db
      .from('positions')
      .select('qty, avg_price, leverage')
      .eq('account_id', accountId)
      .eq('instrument_id', instrumentId)
      .maybeSingle()
    if (error) throw error
    return data
      ? { qty: Number(data.qty), avgPrice: Number(data.avg_price), leverage: Number(data.leverage) }
      : { qty: 0, avgPrice: 0, leverage: 1 }
  }

  private async positionViews(accountId: string): Promise<PositionView[]> {
    const { data, error } = await this.db
      .from('positions')
      .select('instrument_id, qty, avg_price, leverage')
      .eq('account_id', accountId)
    if (error) throw error
    return (data ?? [])
      .map((p) => {
        const qty = Number(p.qty)
        const avgPrice = Number(p.avg_price)
        const leverage = Number(p.leverage)
        return {
          ticker: this.idToTicker.get(p.instrument_id as string) ?? (p.instrument_id as string),
          qty,
          avgPrice,
          leverage,
          marginUsedInr: positionMargin(qty, avgPrice, leverage) * usdInr(),
          liquidationPrice: liquidationPrice({ qty, avgPrice, leverage }, MAINTENANCE_MARGIN_RATE),
        }
      })
      .filter((p) => p.qty !== 0)
  }

  /** Available margin in USD: startingCash + realizedPnL − marginUsed − marginReserved. */
  private async availableMarginUsd(accountId: string): Promise<number> {
    const startingUsd = (await this.startingCashInr(accountId)) / usdInr()
    const realizedUsd = this.realizedPnlUsd.get(accountId) ?? 0
    const { data, error } = await this.db
      .from('positions')
      .select('qty, avg_price, leverage')
      .eq('account_id', accountId)
    if (error) throw error
    const marginUsedUsd = (data ?? []).reduce(
      (a, p) => a + positionMargin(Number(p.qty), Number(p.avg_price), Number(p.leverage)),
      0,
    )
    return startingUsd + realizedUsd - marginUsedUsd - this.reservedMarginUsd(accountId)
  }

  private async startingCashInr(accountId: string): Promise<number> {
    const { data, error } = await this.db
      .from('profiles')
      .select('starting_cash')
      .eq('id', accountId)
      .single()
    if (error || !data) throw error ?? new Error(`no profile for ${accountId}`)
    return Number(data.starting_cash)
  }

  /** Push an order's current in-engine state (status, remaining) to its DB row. */
  private async syncOrderState(orderId: string): Promise<void> {
    const o = this.orders.get(orderId)
    if (!o) return
    const { error } = await this.db
      .from('orders')
      .update({ status: o.status, remaining_qty: o.remainingQty })
      .eq('id', orderId)
    if (error) throw error
  }

  private async reject(
    input: PlaceOrderInput,
    reason: string,
    extra: Record<string, unknown> = {},
  ): Promise<PlaceOrderResult> {
    await this.log(input.accountId, 'order_rejected', 'warning', {
      reason,
      instrument: input.ticker,
      side: input.side,
      type: input.type,
      price: input.price ?? null,
      qty: input.qty,
      leverage: input.leverage ?? 1,
      ...extra,
    })
    return { accepted: false, reason }
  }

  /**
   * Catch-all diagnostics sink for UNEXPECTED server exceptions (as opposed to
   * expected, structured rejections like `order_rejected`). The API layer calls
   * this from its top-level handler so any error bubbling out of the trading
   * service is recorded in the same event_log feed the master already watches,
   * BEFORE the request fails as an HTTP 500.
   *
   * Unlike `log()`, this NEVER throws: a logging failure must not mask the
   * original error or crash the request handler, so a DB write failure here is
   * swallowed to stderr. account_id is best-effort — null for pre-auth errors.
   */
  async logError(message: string, context: Record<string, unknown> = {}): Promise<void> {
    const accountId = typeof context.accountId === 'string' ? context.accountId : null
    const { error } = await this.db.from('event_log').insert({
      account_id: accountId,
      event_type: 'error',
      payload: { message, ...context },
      severity: 'error',
    })
    if (error) console.error('event_log error-logging failed:', error.message)
  }

  private async log(
    accountId: string | null,
    eventType: string,
    severity: Severity,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.db
      .from('event_log')
      .insert({ account_id: accountId, event_type: eventType, payload, severity })
    if (error) throw error
  }
}
