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
  applyCashFill,
  commissionInrFor,
  effectiveEntryRate,
  isLiquidatable,
  liquidationPrice,
  postedMarginInr,
  xirr,
  type CashPosition,
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
import { COMMISSION_RATE, MAINTENANCE_MARGIN_RATE, USD_INR } from './config'

type Severity = 'info' | 'warning' | 'error'
const EPS = 1e-9

/** One closed (or reduced) position, reconstructed from the trades table. */
interface TradeHistoryEntry {
  ticker: string
  side: 'long' | 'short'
  entryPriceInr: number
  exitPriceInr: number
  qty: number
  grossPnlInr: number
  commissionInr: number
  realizedPnlInr: number
  closedAt: number
}

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
  /**
   * Top-of-book on the far side the instant BEFORE this order matched — best ask
   * for a buy, best bid for a sell. MARKET orders only, and absent when that
   * side of the book was empty.
   *
   * Captured server-side because only this process knows the book at match time;
   * the terminal's depth poll can be up to a second stale, which would make the
   * slippage nudge quietly wrong.
   */
  bestPriceAtSubmit?: number
}

/** A position enriched with its INR cost basis, posted margin and liquidation price. */
export interface PositionView {
  ticker: string
  qty: number
  /** Average entry price in USD. */
  avgPrice: number
  leverage: number
  /** Blended USD→INR rate the position was entered at. */
  entryRateInr: number | null
  /** Fixed INR cost basis (full notional). Never revalued while held. */
  costBasisInr: number
  /** Cash locked as margin: costBasis / leverage. */
  marginUsedInr: number
  /** USD price at which the position liquidates — risk only, not a valuation. */
  liquidationPrice: number | null
}

/** An account's buying-power snapshot (all figures in INR). */
export interface AccountState {
  startingCashInr: number
  realizedPnlInr: number
  /** Margin posted by open positions (Σ costBasis / leverage). */
  marginUsedInr: number
  /** Margin locked up by the account's resting (unfilled) orders. */
  marginReservedInr: number
  /** startingCash + realizedPnL − marginUsed − marginReserved. No unrealized P&L exists. */
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
  /**
   * accountId -> running realized P&L in INR (mirrors profiles.realized_pnl_inr).
   * INR, not USD: realized P&L is the difference between two INR amounts struck
   * at two different rates, so it has no single USD equivalent.
   */
  private readonly realizedPnlInr = new Map<string, number>()
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
  /** Event-clock second the active round started; its scheduled end is this + duration. */
  private roundStartedAtSecond = 0
  /**
   * Serializes round transitions. A round end mutates the RoundController and
   * then the DB across several awaits, and it can be triggered concurrently from
   * many places (every polling request checks the elapsed duration, the 1s timer
   * ticks, and the Master can click "end" at the same moment). Without this,
   * two callers both observe an active round and the loser throws
   * 'no active round to end'.
   */
  private roundOps: Promise<unknown> = Promise.resolve()

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
   *   - the full round history into RoundController: every 'ended' round burned
   *     so it can never be replayed, and any 'active' round re-activated with
   *     its correct remaining time,
   *   - all 'active'/'partially_filled' orders onto the engine's books (resting,
   *     no re-matching), which also rebuilds reserved-margin tracking,
   *   - each account's realized P&L into memory.
   * Logs 'server_recovered' (warning) with counts. No-op (and no log) if there
   * is nothing to restore (i.e. a genuinely fresh event).
   */
  async rehydrate(): Promise<RecoveryResult> {
    if (this.tickerToId.size === 0) await this.loadInstruments()

    const roundsRestored = await this.restoreRounds()
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

  /**
   * Reconcile the RoundController with persisted round history.
   *
   * A fresh RoundController comes up with every round 'pending'. Restoring only
   * the *active* round is not enough: once every round has ended, there is no
   * active round to restore, the controller stays entirely 'pending', and the
   * next `startRound()` serves up a round that already ran — overwriting its
   * real history. So burn every round the DB records as 'ended' too, in
   * schedule order, and re-activate an 'active' round with its true elapsed time.
   *
   * Returns the number of rounds reconciled (ended + active).
   */
  private async restoreRounds(): Promise<number> {
    const { data, error } = await this.db.from('rounds').select('*').order('index')
    if (error) throw error
    const rows = new Map((data ?? []).map((r) => [r.id as string, r]))

    const schedule = this.rounds.getSchedule()
    const active = (data ?? []).find((r) => r.status === 'active')
    const activeIdx = active ? schedule.findIndex((r) => r.id === active.id) : -1
    if (active && activeIdx < 0) {
      throw new Error(`active round ${active.id} not in RoundController config`)
    }

    let reconciled = 0
    for (let i = 0; i < schedule.length; i++) {
      if (i === activeIdx) {
        // Start the target at event-second 0 (the service clock is pinned there);
        // remaining time comes from the persisted wall-clock start + duration.
        this.rounds.startNextRound(0)
        this.nowSeconds = 0
        this.roundStartedAtSecond = 0
        this.activeRoundId = active!.id as string
        this.roundStartedAtMs = Date.parse(active!.started_at as string)
        this.roundDurationSeconds = Number(active!.duration_seconds)
        // Restore the PINNED rate — settlement depends on it, so a restart must
        // not silently revert the round to the config default.
        const persistedRate = Number(active!.usd_inr_rate)
        if (Number.isFinite(persistedRate) && persistedRate > 0) {
          this.rounds.setUsdInrRate(persistedRate)
        }
        reconciled++
        break
      }

      const isEnded = rows.get(schedule[i].id)?.status === 'ended'
      if (!isEnded) {
        // No finished row: this round has not run. With no active round beyond
        // it there is nothing left to reconcile.
        if (activeIdx < 0) break
        // Otherwise there is a gap before the active round (usually the event
        // config changed between deploys). Burn it so the controller can reach
        // the active round, but say so loudly.
        console.warn(
          `rehydrate: no 'ended' row for ${schedule[i].id}; ` +
            `burning it to reach active round ${active!.id}`,
        )
      }
      this.rounds.startNextRound(0)
      this.rounds.endCurrentRound(0)
      if (isEnded) reconciled++
    }
    return reconciled
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
    const { data, error } = await this.db
      .from('profiles')
      .select('id, realized_pnl_inr')
      .neq('realized_pnl_inr', 0)
    if (error) throw error
    for (const row of data ?? []) {
      this.realizedPnlInr.set(row.id as string, Number(row.realized_pnl_inr))
    }
    return (data ?? []).length
  }

  // -------------------------------------------------------------------------
  // Rounds
  // -------------------------------------------------------------------------

  async startRound(atSecond: number): Promise<Round> {
    return this.serializeRoundOp(() => this.startRoundInner(atSecond))
  }

  private async startRoundInner(atSecond: number): Promise<Round> {
    // Guard BEFORE mutating the controller: if the round we are about to start
    // already has a row in the DB, the controller is out of sync with persisted
    // history and the upsert below would silently overwrite that round's real
    // started_at/ended_at. Peek at the next pending round rather than starting
    // it first, so a refusal leaves the controller untouched.
    const next = this.rounds.getSchedule().find((r) => r.status === 'pending')
    if (next) {
      const { data: existing, error: exErr } = await this.db
        .from('rounds')
        .select('status, started_at, ended_at')
        .eq('id', next.id)
        .maybeSingle()
      if (exErr) throw exErr
      if (existing && existing.status !== 'pending') {
        throw new Error(
          `refusing to start round ${next.id}: the database already has it as ` +
            `'${existing.status}' (started_at=${existing.started_at}, ended_at=${existing.ended_at}). ` +
            `Starting it would overwrite that round's history — rehydrate() must run ` +
            `before round transitions are accepted.`,
        )
      }
    }

    const round = this.rounds.startNextRound(atSecond)
    this.activeRoundId = round.id
    this.nowSeconds = atSecond
    this.roundStartedAtSecond = atSecond
    this.roundStartedAtMs = Date.now()
    this.roundDurationSeconds = round.durationSeconds

    const { error } = await this.db.from('rounds').upsert(
      {
        id: round.id,
        index: round.index,
        mode: round.mode,
        duration_seconds: round.durationSeconds,
        commission_enabled: round.commissionEnabled,
        usd_inr_rate: round.usdInrRate,
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

  /** End the active round early (Master Terminal override). */
  async endRound(atSecond: number): Promise<Round> {
    return this.serializeRoundOp(() => this.endRoundInner(atSecond, false))
  }

  private async endRoundInner(atSecond: number, auto: boolean): Promise<Round> {
    const round = this.rounds.endCurrentRound(atSecond)
    this.nowSeconds = atSecond

    // Clear the book BEFORE closing the round out: a round is a self-contained
    // trading session, so no order may rest into the next one, and the margin
    // those orders reserve has to be released with them.
    const cancelledOrderIds = await this.sweepRestingOrders()

    const { error } = await this.db
      .from('rounds')
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', round.id)
    if (error) throw error

    if (this.activeRoundId === round.id) {
      this.activeRoundId = null
      this.roundStartedAtMs = null
    }
    await this.log(null, 'round_ended', 'info', {
      roundId: round.id,
      index: round.index,
      auto,
      ordersCancelled: cancelledOrderIds.length,
    })
    return round
  }

  /**
   * End the active round if its duration has fully elapsed on the wall clock.
   * Returns the round that was ended, or null when nothing was due.
   *
   * The RoundController is a pure state machine with no clock of its own, so
   * something has to drive it. This is that driver: cheap enough to call on
   * every request (a no-op comparison when nothing is due) and also ticked by a
   * timer in the API server, so a round closes on schedule whether or not the
   * Master clicks "end" and whether or not anyone is still polling.
   */
  async maybeAutoEndRound(): Promise<Round | null> {
    if (!this.isRoundElapsed()) return null // fast path, outside the lock
    return this.serializeRoundOp(async () => {
      // Re-check under the lock: a concurrent caller may have ended it already.
      if (!this.isRoundElapsed()) return null
      return this.endRoundInner(this.roundStartedAtSecond + this.roundDurationSeconds, true)
    })
  }

  /** Whether an active round's full duration has elapsed on the wall clock. */
  private isRoundElapsed(): boolean {
    if (this.activeRoundId === null || this.roundStartedAtMs === null) return false
    return Date.now() - this.roundStartedAtMs >= this.roundDurationSeconds * 1000
  }

  /**
   * Cancel every order still resting on any book, persisting each as
   * 'cancelled'. Returns the ids cancelled. Reserved margin is derived from
   * these same in-memory order objects, so it is released as a side effect.
   */
  private async sweepRestingOrders(): Promise<string[]> {
    const resting = [...this.orders.values()].filter(
      (o) => o.status === 'active' || o.status === 'partially_filled',
    )
    const cancelled: string[] = []
    for (const o of resting) {
      // cancelOrder returns false for anything not actually on a book; mark
      // those cancelled directly so the DB never shows them as still working.
      if (!this.engine.cancelOrder(o.id)) o.status = 'cancelled'
      await this.syncOrderState(o.id)
      cancelled.push(o.id)
    }
    return cancelled
  }

  /**
   * Run a round transition with exclusive access, queued behind any in-flight
   * one. Failures don't poison the chain — later transitions still run.
   */
  private serializeRoundOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.roundOps.then(fn, fn)
    this.roundOps = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * The USD→INR rate settlement uses right now: the active round's pinned rate,
   * falling back to the configured base between rounds (where nothing settles
   * anyway, but reads still need a number to format with).
   *
   * This never drifts. Under cash settlement a rate move realizes real P&L on
   * every close, so the rate only changes when the Master changes it.
   */
  rateInr(): number {
    return this.rounds.getUsdInrRate() ?? USD_INR
  }

  /**
   * Master control: pin a new USD→INR rate on the active round (or the next
   * pending one), persisting it. Returns the round changed, or null if there is
   * neither an active nor a pending round.
   */
  async setUsdInrRate(rate: number): Promise<Round | null> {
    const changed = this.rounds.setUsdInrRate(rate)
    if (!changed) return null
    // Only an already-started round has a row to update.
    if (changed.status !== 'pending') {
      const { error } = await this.db
        .from('rounds')
        .update({ usd_inr_rate: changed.usdInrRate })
        .eq('id', changed.id)
      if (error) throw error
    }
    await this.log(null, 'usd_inr_rate_changed', 'info', {
      roundId: changed.id,
      index: changed.index,
      usdInrRate: changed.usdInrRate,
    })
    return changed
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
    /** USD→INR pinned for this round (or the base rate between rounds). */
    usdInrRate: number
  } {
    const cur = this.activeRoundId === null ? null : this.rounds.getCurrentRound()
    return {
      active: cur !== null,
      id: cur?.id ?? null,
      index: cur?.index ?? null,
      mode: cur?.mode ?? null,
      commissionEnabled: cur?.commissionEnabled ?? false,
      remainingSeconds: this.getRoundRemainingSeconds(),
      usdInrRate: this.rateInr(),
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
    const rate = this.rateInr()
    const existing = await this.cashPosition(input.accountId, instrumentId)
    const signedQty = input.side === 'buy' ? input.qty : -input.qty
    // Cash this order needs is exactly the cash it would move, negated: margin
    // posted less margin released less P&L realized. Opens/adds require cash;
    // reduces and closes free it (a negative requirement), and a closing loss
    // correctly still needs the cash to absorb it.
    const projected = applyCashFill(existing, signedQty, valuationPrice, rate, leverage)
    const requiredInr = -projected.cashFlowInr
    const availableInr = await this.availableCashInr(input.accountId)
    if (requiredInr > availableInr + EPS) {
      return this.reject(input, 'insufficient_margin', {
        requiredMarginInr: requiredInr,
        availableMarginInr: availableInr,
        leverage,
        usdInrRate: rate,
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

    // 7. Top-of-book on the far side, captured BEFORE matching consumes it —
    // this is the price the taker could have got with a limit order, and the
    // baseline the terminal's slippage nudge measures against. Market orders
    // only: a limit order guarantees its own price, so it cannot slip.
    let bestPriceAtSubmit: number | undefined
    if (order.type === 'market') {
      const book = this.engine.getDepth(input.ticker)
      bestPriceAtSubmit = (order.side === 'buy' ? book.asks[0] : book.bids[0])?.price
    }

    // 8. Match.
    const trades =
      order.type === 'limit'
        ? this.engine.placeLimitOrder(order)
        : this.engine.placeMarketOrder(order)

    // 9. Persist every resulting trade + both sides' positions. The taker (this
    // order) is the aggressor, which drives the Times & Sales Buy/Sell column.
    for (const trade of trades) await this.persistTrade(trade, instrumentId, roundId, order.side)

    // 10. Sync the taker and every matched maker's status/remaining to the DB.
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
      bestPriceAtSubmit,
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

  /**
   * Buying-power snapshot for an account, all in INR. There is no unrealized
   * term: an open position contributes only the margin it has locked.
   */
  async getAccountState(accountId: string): Promise<AccountState> {
    const startingCashInr = await this.startingCashInr(accountId)
    const positions = await this.positionViews(accountId)
    const marginUsedInr = positions.reduce((a, p) => a + p.marginUsedInr, 0)
    const marginReservedInr = this.reservedMarginInr(accountId)
    const realizedPnlInr = this.realizedPnlInr.get(accountId) ?? 0
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
    return this.reservedMarginInr(accountId)
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
      rate: this.rateInr(),
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

  /**
   * Everything the Portfolio page needs, in INR at the round's pinned rate.
   *
   * Under cash settlement an open position has NO live value: it shows its fixed
   * cost basis and the rate it was entered at, and nothing about it changes until
   * it is closed. So there is no unrealized P&L, no mark-to-market column and no
   * position market value here — total P&L is realized P&L, full stop.
   */
  async portfolio(accountId: string): Promise<Record<string, unknown>> {
    const rate = this.rateInr()
    const realizedPnlInr = this.realizedPnlInr.get(accountId) ?? 0

    // These four reads are INDEPENDENT — run them concurrently. Each is a remote
    // Supabase round-trip (~180ms); done serially they were this endpoint's
    // dominant cost (~4× latency ≈ 0.75s). One round-trip's worth now.
    const [openingBalanceInr, positionsRes, t0, replay] = await Promise.all([
      this.startingCashInr(accountId),
      this.db
        .from('positions')
        .select('instrument_id, qty, avg_price, leverage, notional_basis_inr')
        .eq('account_id', accountId),
      this.eventStartMs(),
      this.historyAndCharges(accountId),
    ])
    const { history: tradeHistory, chargesInr } = replay
    if (positionsRes.error) throw positionsRes.error
    const data = positionsRes.data
    const posByTicker = new Map(
      (data ?? []).map((p) => [this.idToTicker.get(p.instrument_id as string) ?? '', p]),
    )

    let openPositions = 0
    let levNotionalInr = 0 // entry notional, for the weighted-average leverage
    let levMarginInr = 0
    const inventory = [...this.instrumentMeta].map(([ticker, meta], i) => {
      const p = posByTicker.get(ticker)
      // LTP is still shown: teams need the live price to trade. It is NOT used to
      // value their holdings.
      const ltp = this.lastPrice.get(ticker) ?? meta.referencePrice
      const qty = p ? Number(p.qty) : 0
      if (qty === 0) {
        return {
          index: i + 1, ticker, name: meta.name, ltp,
          qty: null, leverage: null, avgPrice: null,
          avgEntryInr: null, currentPriceInr: null,
          entryRateInr: null, costBasisInr: null, marginUsedInr: null,
        }
      }
      openPositions++
      const cash: CashPosition = {
        qty,
        avgPrice: Number(p!.avg_price),
        notionalBasisInr: Number(p!.notional_basis_inr),
        leverage: Number(p!.leverage),
      }
      const costBasisInr = Math.abs(cash.notionalBasisInr)
      const marginUsedInr = postedMarginInr(cash)
      levNotionalInr += costBasisInr
      levMarginInr += marginUsedInr
      return {
        index: i + 1, ticker, name: meta.name, ltp,
        qty, leverage: cash.leverage, avgPrice: cash.avgPrice,
        // Entry price converted at the rate the position was actually entered at,
        // not today's — that is the whole point of a fixed basis.
        avgEntryInr: cash.avgPrice * (effectiveEntryRate(cash) ?? rate),
        currentPriceInr: ltp * rate,
        entryRateInr: effectiveEntryRate(cash),
        costBasisInr,
        marginUsedInr,
      }
    })
    // Effective portfolio leverage: total notional / total margin posted (1× flat).
    const leverageReq = levMarginInr > 0 ? levNotionalInr / levMarginInr : 1

    const marginUsedInr = levMarginInr
    const marginReservedInr = this.reservedMarginInr(accountId)
    // Equity is opening capital plus realized P&L — nothing else can move it,
    // because held positions are never revalued.
    const totalPortfolioValueInr = openingBalanceInr + realizedPnlInr
    const cashInr = totalPortfolioValueInr - marginUsedInr - marginReservedInr
    const totalPnlInr = realizedPnlInr
    const totalPnlPct = openingBalanceInr > 0 ? (totalPnlInr / openingBalanceInr) * 100 : 0
    // chargesInr comes from the trades replay above, NOT from tradeHistory:
    // history only records fills that realized something, so summing it dropped
    // the commission charged on opening fills entirely.

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
      realizedPnlInr,
      cashInr,
      inventory,
      marginUsedInr,
      marginReservedInr,
      totalPnlInr,
      totalPnlPct,
      totalPortfolioValueInr,
      xirr: xirrValue,
      // Effective portfolio leverage (weighted average of open positions; 1× flat).
      leverageReq,
      openPositions,
      chargesInr,
      tradeHistory, // fetched concurrently above
    }
  }

  /**
   * Admin-only overview of every team: equity + total P&L (same math as the
   * portfolio page). Equity is opening capital plus REALIZED P&L only — held
   * positions are never revalued, so an open position moves nothing until it is
   * closed. `openPositions` is still reported so the Master can see who is
   * carrying exposure.
   */
  async teamsOverview(): Promise<
    { username: string; teamName: string | null; equityInr: number; totalPnlInr: number; totalPnlPct: number; openPositions: number }[]
  > {
    const { data: profs, error: pErr } = await this.db
      .from('profiles')
      .select('id, username, team_name, starting_cash, realized_pnl_inr')
      .eq('role', 'team')
      .order('username')
    if (pErr) throw pErr

    const { data: allPos, error: posErr } = await this.db
      .from('positions')
      .select('account_id, qty')
    if (posErr) throw posErr
    const openByAccount = new Map<string, number>()
    for (const p of allPos ?? []) {
      if (Number(p.qty) === 0) continue
      const id = p.account_id as string
      openByAccount.set(id, (openByAccount.get(id) ?? 0) + 1)
    }

    return (profs ?? []).map((pr) => {
      const realizedInr = this.realizedPnlInr.get(pr.id as string) ?? Number(pr.realized_pnl_inr)
      const openingInr = Number(pr.starting_cash)
      return {
        username: pr.username as string,
        teamName: (pr.team_name as string | null) ?? null,
        equityInr: openingInr + realizedInr,
        totalPnlInr: realizedInr,
        totalPnlPct: openingInr > 0 ? (realizedInr / openingInr) * 100 : 0,
        openPositions: openByAccount.get(pr.id as string) ?? 0,
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
   * We replay the account's fills in time order through the SAME cash-settlement
   * math the live path uses, each at the rate that fill actually settled at
   * (`trades.usd_inr_rate`), so the reconstruction is exact rather than an
   * approximation at today's rate. Every fill that closes/reduces/flips emits one
   * closed-trade record. Most recent first, all amounts INR.
   */
  async tradeHistory(accountId: string): Promise<TradeHistoryEntry[]> {
    return (await this.historyAndCharges(accountId)).history
  }

  /**
   * One replay of an account's fills producing BOTH the closed-trade history and
   * the total commission charged.
   *
   * They are deliberately different measures and must not be derived from each
   * other:
   *
   *   history  — one record per fill that closed or reduced a position. An
   *              opening fill produces no record, because nothing was realized.
   *   charges  — every rupee of commission the engine actually took, across ALL
   *              fills including pure opens. Deriving this from `history` used to
   *              silently drop the commission on opening fills.
   *
   * The invariant that ties them back to the ledger is
   * `Σ history.grossPnlInr − chargesInr === profiles.realized_pnl_inr`.
   */
  private async historyAndCharges(
    accountId: string,
  ): Promise<{ history: TradeHistoryEntry[]; chargesInr: number }> {
    const { data: myOrders, error: oErr } = await this.db
      .from('orders')
      .select('id, leverage')
      .eq('account_id', accountId)
    if (oErr) throw oErr
    const ids = (myOrders ?? []).map((o) => o.id as string)
    if (ids.length === 0) return { history: [], chargesInr: 0 }
    const idSet = new Set(ids)
    const leverageByOrder = new Map((myOrders ?? []).map((o) => [o.id as string, Number(o.leverage)]))
    const inList = `(${ids.join(',')})`

    // Per-round commission flag and rate fallback, for trades that predate
    // usd_inr_rate being recorded on the trade itself.
    const { data: roundRows } = await this.db
      .from('rounds')
      .select('id, commission_enabled, usd_inr_rate')
    const commissionByRound = new Map((roundRows ?? []).map((r) => [r.id as string, r.commission_enabled as boolean]))
    const rateByRound = new Map((roundRows ?? []).map((r) => [r.id as string, Number(r.usd_inr_rate)]))

    const { data: trades, error: tErr } = await this.db
      .from('trades')
      .select('price, qty, created_at, instrument_id, round_id, buy_order_id, sell_order_id, usd_inr_rate')
      .or(`buy_order_id.in.${inList},sell_order_id.in.${inList}`)
      .order('created_at', { ascending: true })
    if (tErr) throw tErr

    const pos = new Map<string, CashPosition>()
    const history: TradeHistoryEntry[] = []
    let chargesInr = 0

    for (const t of trades ?? []) {
      const isBuyer = idSet.has(t.buy_order_id as string)
      const isSeller = idSet.has(t.sell_order_id as string)
      if (!isBuyer && !isSeller) continue // not this account's fill at all

      const price = Number(t.price)
      // The rate this fill settled at, with graceful fallbacks for pre-migration rows.
      const fillRate =
        t.usd_inr_rate !== null && t.usd_inr_rate !== undefined
          ? Number(t.usd_inr_rate)
          : (rateByRound.get(t.round_id as string) ?? USD_INR)
      // Charged on the FULL fill notional, matching settleFill — not just the
      // portion that closes, which differs when a fill flips through zero.
      const commissionInr = commissionInrFor(
        Number(t.qty),
        price,
        fillRate,
        commissionByRound.get(t.round_id as string) ?? false,
      )

      // Commission is charged per SIDE. If this account somehow sat on both sides
      // of one fill, settleFill charged it twice, so count it twice here.
      chargesInr += commissionInr * ((isBuyer ? 1 : 0) + (isSeller ? 1 : 0))

      if (isBuyer === isSeller) continue // self-trade → no net position effect

      const signed = isBuyer ? Number(t.qty) : -Number(t.qty)
      const ticker = this.idToTicker.get(t.instrument_id as string) ?? (t.instrument_id as string)
      const myOrderId = (isBuyer ? t.buy_order_id : t.sell_order_id) as string
      const leverage = leverageByOrder.get(myOrderId) ?? 1

      const cur = pos.get(ticker) ?? { qty: 0, avgPrice: 0, notionalBasisInr: 0, leverage }
      const next = applyCashFill(cur, signed, price, fillRate, leverage)
      if (next.realizedPnlInr !== 0) {
        const gross = next.realizedPnlInr
        const perUnitBasisInr = cur.notionalBasisInr / cur.qty
        history.push({
          ticker,
          side: cur.qty > 0 ? 'long' : 'short', // the position that was closed/reduced
          // Entry in INR at the rate it was ENTERED at; exit at this fill's rate.
          entryPriceInr: perUnitBasisInr,
          exitPriceInr: price * fillRate,
          qty: next.closedQty,
          grossPnlInr: gross,
          commissionInr,
          realizedPnlInr: gross - commissionInr, // net: proceeds − basis − charges
          closedAt: Date.parse(t.created_at as string),
        })
      }
      pos.set(ticker, {
        qty: next.qty,
        avgPrice: next.avgPrice,
        notionalBasisInr: next.notionalBasisInr,
        leverage: next.leverage,
      })
    }
    return { history: history.reverse(), chargesInr } // most recent first
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

    // The rate this fill settles at — pinned by the round, recorded on the trade
    // so history stays reproducible even if the Master changes it later.
    const rate = this.rateInr()

    // DB assigns the trade's own uuid pk; the engine trade id is not stored.
    const { error: tErr } = await this.db.from('trades').insert({
      buy_order_id: trade.buyOrderId,
      sell_order_id: trade.sellOrderId,
      instrument_id: instrumentId,
      round_id: roundId,
      price: trade.price,
      qty: trade.qty,
      aggressor,
      usd_inr_rate: rate,
    })
    if (tErr) throw tErr

    // Commission: charged to BOTH sides as a % of notional, but only while the
    // active round has commission enabled. A cost, so it is deducted from each
    // account's realized P&L at the time of the fill. INR, like everything else
    // that settles.
    const commissionInr = commissionInrFor(trade.qty, trade.price, rate, this.rounds.isCommissionActive())

    // Buyer gains qty, seller loses qty — each valued at the execution price and
    // using ITS OWN order's leverage (matters only when the fill opens/flips).
    await this.applyPosition(buyer.userId, instrumentId, trade.qty, trade.price, rate, this.orderLeverage.get(buyer.id) ?? 1, commissionInr)
    await this.applyPosition(seller.userId, instrumentId, -trade.qty, trade.price, rate, this.orderLeverage.get(seller.id) ?? 1, commissionInr)

    const ticker = this.idToTicker.get(instrumentId) ?? instrumentId
    // One order_matched event per side so each account sees its own fill.
    const base = { instrument: ticker, price: trade.price, qty: trade.qty, buyOrderId: trade.buyOrderId, sellOrderId: trade.sellOrderId }
    await this.log(buyer.userId, 'order_matched', 'info', { ...base, side: 'buy' })
    await this.log(seller.userId, 'order_matched', 'info', { ...base, side: 'sell' })

    // Audit each side's commission.
    if (commissionInr > 0) {
      const audit = { instrument: ticker, qty: trade.qty, price: trade.price, notional: trade.qty * trade.price, commissionRate: COMMISSION_RATE, usdInrRate: rate, commissionInr }
      await this.log(buyer.userId, 'commission_charged', 'info', { ...audit, side: 'buy' })
      await this.log(seller.userId, 'commission_charged', 'info', { ...audit, side: 'sell' })
    }
  }

  /**
   * Settle one side of a fill under INR cash accounting: update the position's
   * qty / entry price / INR basis, and move realized P&L by the amount this fill
   * locked in, net of commission.
   *
   * `rate` is the USD→INR rate at THIS fill — baked into basis when opening or
   * adding, and used to value the exit when reducing or closing.
   */
  private async applyPosition(
    accountId: string,
    instrumentId: string,
    delta: number,
    price: number,
    rate: number,
    fillLeverage: number,
    commissionInr = 0,
  ): Promise<void> {
    const current = await this.cashPosition(accountId, instrumentId)
    const next = applyCashFill(current, delta, price, rate, fillLeverage)

    const { error: upErr } = await this.db.from('positions').upsert(
      {
        account_id: accountId,
        instrument_id: instrumentId,
        qty: next.qty,
        avg_price: next.avgPrice,
        notional_basis_inr: next.notionalBasisInr,
        leverage: next.leverage,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,instrument_id' },
    )
    if (upErr) throw upErr

    // Realized P&L (INR, locked) net of commission. Commission alone moves
    // realized even on an opening fill (where position P&L is 0). Absolute
    // running total — this process is the single authoritative writer.
    const netRealizedInr = next.realizedPnlInr - commissionInr
    if (netRealizedInr !== 0) {
      const totalInr = (this.realizedPnlInr.get(accountId) ?? 0) + netRealizedInr
      this.realizedPnlInr.set(accountId, totalInr)
      const { error: pnlErr } = await this.db
        .from('profiles')
        .update({ realized_pnl_inr: totalInr })
        .eq('id', accountId)
      if (pnlErr) throw pnlErr
    }
  }

  /**
   * Margin (INR) locked by an account's currently-resting orders. Derived live
   * from the in-memory order objects (which the engine mutates), so it reflects
   * partial fills and cancellations immediately. Each resting order reserves
   * remainingQty · price · rate / leverage — the cash it would post if it filled.
   * `excludeOrderId` omits one order (unused at placement, since the new order
   * isn't resting yet).
   */
  private reservedMarginInr(accountId: string, excludeOrderId?: string): number {
    const rate = this.rateInr()
    let total = 0
    for (const o of this.orders.values()) {
      if (o.userId !== accountId || o.id === excludeOrderId) continue
      if (o.status !== 'active' && o.status !== 'partially_filled') continue
      if (o.price === undefined) continue // market orders never rest
      total += (o.remainingQty * o.price * rate) / (this.orderLeverage.get(o.id) ?? 1)
    }
    return total
  }

  /**
   * Current cash-settled position for an account+instrument; flat if none.
   * Carries the fixed INR basis alongside the USD entry price (the latter still
   * feeds liquidation math, which stays a USD risk measure).
   */
  private async cashPosition(accountId: string, instrumentId: string): Promise<CashPosition> {
    const { data, error } = await this.db
      .from('positions')
      .select('qty, avg_price, leverage, notional_basis_inr')
      .eq('account_id', accountId)
      .eq('instrument_id', instrumentId)
      .maybeSingle()
    if (error) throw error
    return data
      ? {
          qty: Number(data.qty),
          avgPrice: Number(data.avg_price),
          notionalBasisInr: Number(data.notional_basis_inr),
          leverage: Number(data.leverage),
        }
      : { qty: 0, avgPrice: 0, notionalBasisInr: 0, leverage: 1 }
  }

  /** The USD-only view of a position, for liquidation/risk math. */
  private async leveredPosition(accountId: string, instrumentId: string): Promise<LeveredPosition> {
    const p = await this.cashPosition(accountId, instrumentId)
    return { qty: p.qty, avgPrice: p.avgPrice, leverage: p.leverage }
  }

  private async positionViews(accountId: string): Promise<PositionView[]> {
    const { data, error } = await this.db
      .from('positions')
      .select('instrument_id, qty, avg_price, leverage, notional_basis_inr')
      .eq('account_id', accountId)
    if (error) throw error
    return (data ?? [])
      .map((p) => {
        const cash: CashPosition = {
          qty: Number(p.qty),
          avgPrice: Number(p.avg_price),
          notionalBasisInr: Number(p.notional_basis_inr),
          leverage: Number(p.leverage),
        }
        return {
          ticker: this.idToTicker.get(p.instrument_id as string) ?? (p.instrument_id as string),
          qty: cash.qty,
          avgPrice: cash.avgPrice,
          leverage: cash.leverage,
          entryRateInr: effectiveEntryRate(cash),
          costBasisInr: Math.abs(cash.notionalBasisInr),
          marginUsedInr: postedMarginInr(cash),
          // Risk only — computed from the internal mark, never shown as P&L.
          liquidationPrice: liquidationPrice(cash, MAINTENANCE_MARGIN_RATE),
        }
      })
      .filter((p) => p.qty !== 0)
  }

  /**
   * Spendable INR: startingCash + realizedPnL − margin posted by open positions
   * − margin reserved by resting orders. There is no unrealized term: a held
   * position contributes only the cash it has locked up.
   */
  private async availableCashInr(accountId: string): Promise<number> {
    const startingInr = await this.startingCashInr(accountId)
    const realizedInr = this.realizedPnlInr.get(accountId) ?? 0
    const marginUsedInr = await this.postedMarginTotalInr(accountId)
    return startingInr + realizedInr - marginUsedInr - this.reservedMarginInr(accountId)
  }

  /** Total INR margin posted by an account's open positions. */
  private async postedMarginTotalInr(accountId: string): Promise<number> {
    const { data, error } = await this.db
      .from('positions')
      .select('qty, leverage, notional_basis_inr')
      .eq('account_id', accountId)
    if (error) throw error
    return (data ?? []).reduce(
      (a, p) =>
        a +
        postedMarginInr({
          qty: Number(p.qty),
          avgPrice: 0, // unused by postedMarginInr
          notionalBasisInr: Number(p.notional_basis_inr),
          leverage: Number(p.leverage),
        }),
      0,
    )
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
