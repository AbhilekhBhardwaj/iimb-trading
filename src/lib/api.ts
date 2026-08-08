/**
 * Typed client for the engine API server (server/api.ts), reached same-origin at
 * /api via the Vite dev proxy. Every call attaches the logged-in user's Supabase
 * access token; the server verifies it and derives the account + role.
 */
import * as session from './session'

export type Role = 'team' | 'market_maker' | 'master'
export type Side = 'buy' | 'sell'
export type OrderType = 'limit' | 'market'
export type RoundMode = 'data_and_news' | 'only_data' | 'silent'

export interface RoundStatus {
  active: boolean
  id: string | null
  index: number | null
  mode: RoundMode | null
  commissionEnabled: boolean
  remainingSeconds: number | null
  /** USD→INR pinned for this round. Set by the Master; never auto-drifts. */
  usdInrRate: number
  /** Commission rate pinned for this round, as a fraction of notional per side. */
  commissionRate: number
  /** Show the slippage nudge to teams this round. Display-only. */
  slippageEnabled: boolean
}

export interface InstrumentMeta {
  ticker: string
  name: string
  sector: string
  referencePrice: number
}

export interface PositionView {
  ticker: string
  qty: number
  avgPrice: number
  leverage: number
  /** Blended USD→INR rate the position was entered at. */
  entryRateInr: number | null
  /** Fixed INR cost basis (full notional); never revalued while held. */
  costBasisInr: number
  /** Cash locked as margin: costBasis / leverage. */
  marginUsedInr: number
  /** Risk measure only — not a valuation, and never shown as P&L. */
  liquidationPrice: number | null
}

export interface AccountState {
  startingCashInr: number
  realizedPnlInr: number
  marginUsedInr: number
  marginReservedInr: number
  availableMarginInr: number
  positions: PositionView[]
}

export interface InstrumentRow {
  ticker: string
  name: string
  sector: string
  ltp: number
  position: PositionView | null
}

export interface DepthLevel {
  price: number
  /** TOTAL resting quantity at this price, across every account. */
  qty: number
  /**
   * How much of `qty` is THIS account's own resting quantity. Self-trade
   * prevention means it can never fill against itself, so a price preview must
   * subtract it. The ladder still displays the full `qty`.
   */
  ownQty?: number
}
export interface RestingOrder {
  orderId: string
  accountId: string
  side: Side
  price: number
  remainingQty: number
  leverage: number
}
export interface DepthView {
  bids: DepthLevel[]
  asks: DepthLevel[]
  restingOrders?: RestingOrder[]
}

export interface MyOrder {
  orderId: string
  side: Side
  price: number
  qty: number
  remainingQty: number
  status: string
  leverage: number
}

export interface TapeTrade {
  id: string
  t: number
  price: number
  qty: number
  side: Side | null
}

export interface PricePoint {
  t: number
  price: number
  qty: number
}

export interface Notification {
  id: string
  kind: 'announcement' | 'daily_news' | 'data'
  title: string
  body: string | null
  roundId: string | null
  t: number
}

export interface ScheduleRound {
  id: string
  index: number
  mode: RoundMode
  durationSeconds: number
  commissionEnabled: boolean
  status: 'pending' | 'active' | 'ended'
  startedAt: number | null
  endedAt: number | null
  /** USD→INR pinned for this round. Set by the Master; never auto-drifts. */
  usdInrRate: number
  /** Commission rate pinned for this round, as a fraction of notional per side. */
  commissionRate: number
  /** Show the slippage nudge to teams this round. Display-only. */
  slippageEnabled: boolean
}

export interface TeamOverview {
  username: string
  teamName: string | null
  equityInr: number
  totalPnlInr: number
  totalPnlPct: number
  openPositions: number
}

export interface LeaderboardEntry {
  rank: number
  username: string
  teamName: string | null
  equityInr: number
  totalPnlInr: number
  totalPnlPct: number
}

export interface Bootstrap {
  accountId: string
  role: Role
  username: string
  instruments: InstrumentMeta[]
  round: RoundStatus
  rate: number
  serverTime: number
}

/**
 * One row of the instrument inventory. Under INR cash settlement an open
 * position has NO live value: there is no mark-to-market P&L and no position
 * market value. `ltp` / `currentPriceInr` are the live market price (teams need
 * it to trade), NOT a valuation of the holding.
 */
export interface InventoryRow {
  index: number
  ticker: string
  name: string
  ltp: number
  qty: number | null
  leverage: number | null
  avgPrice: number | null
  /** Entry price in INR, converted at the rate the position was ENTERED at. */
  avgEntryInr: number | null
  currentPriceInr: number | null
  /** Blended USD→INR rate the position was entered at. */
  entryRateInr: number | null
  /** Fixed INR cost basis (full notional). Never revalued while held. */
  costBasisInr: number | null
  /** Cash locked as margin: costBasis / leverage. */
  marginUsedInr: number | null
}

export interface TradeHistoryEntry {
  ticker: string
  side: 'long' | 'short'
  entryPriceInr: number
  exitPriceInr: number
  qty: number
  grossPnlInr: number
  commissionInr: number
  realizedPnlInr: number // net = gross − commission
  closedAt: number
}

/** An order still working on the book — the account's own. */
export interface WorkingOrder {
  orderId: string
  ticker: string
  side: Side
  type: OrderType
  /** Limit price; null for a market order (which never rests). */
  price: number | null
  qty: number
  remainingQty: number
  status: string
  leverage: number
  /** Wall-clock ms the order was placed. */
  placedAt: number
}

export interface Portfolio {
  /** USD→INR pinned for the current round. */
  rate: number
  /** Round settings, so a close placed from here matches the Terminal exactly. */
  commissionEnabled: boolean
  commissionRate: number
  slippageEnabled: boolean
  /** The account's currently-working orders, most recent first. */
  workingOrders: WorkingOrder[]
  openingBalanceInr: number
  realizedPnlInr: number
  /** Spendable INR: equity − margin posted − margin reserved. */
  cashInr: number
  inventory: InventoryRow[]
  /** Margin posted by open positions. */
  marginUsedInr: number
  /** Margin reserved by resting orders. */
  marginReservedInr: number
  /** Equals realizedPnlInr — held positions are never revalued. */
  totalPnlInr: number
  totalPnlPct: number
  /** openingBalance + realizedPnl. Nothing else can move it. */
  totalPortfolioValueInr: number
  xirr: number | null
  leverageReq: number
  openPositions: number
  /**
   * Commission actually charged, summed across EVERY fill — opening ones too,
   * which realize nothing and so never appear in `tradeHistory`. Deliberately
   * not equal to the commission visible in the history rows.
   */
  chargesInr: number
  tradeHistory: TradeHistoryEntry[]
}

export interface Snapshot {
  round: RoundStatus
  account: AccountState
  instruments: InstrumentRow[]
  /**
   * The instrument this payload's per-ticker fields (depth, trades, prices,
   * myOrders) belong to. Undefined from a server older than this field.
   */
  ticker?: string | null
  depth: DepthView | null
  myOrders: MyOrder[]
  trades: TapeTrade[]
  prices: PricePoint[]
  notifications: Notification[]
  rate: number
  serverTime: number
}

export interface PlaceOrderInput {
  ticker: string
  side: Side
  type: OrderType
  price?: number
  qty: number
  leverage: number
}

/** One instrument's before/after from a Master price reset. */
export interface InstrumentPriceChange {
  ticker: string
  /** What teams actually saw before — the last traded price, if there was one. */
  oldPrice: number
  newPrice: number
  /** The stored seed price before the change, which may differ from oldPrice. */
  oldReferencePrice: number
}

export interface SetInstrumentPricesResult {
  applied: boolean
  changes: InstrumentPriceChange[]
  /** The full catalogue after the change, so the caller can resync. */
  instruments: InstrumentMeta[]
}

export interface ResetEventResult {
  applied: boolean
  cleared: {
    trades: number
    orders: number
    positions: number
    rounds: number
    notifications: number
    accountsReset: number
  }
  round: RoundStatus
}

/**
 * One position past its liquidation threshold, as the market-maker desk sees it.
 * Mirrors server/tradingService.ts LiquidatableView.
 */
export interface LiquidatableRow {
  accountId: string
  username: string
  ticker: string
  side: 'long' | 'short'
  qty: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number
  /** How far BEYOND the threshold, in USD. Positive means past it. */
  pastByUsd: number
  pastByPct: number
  leverage: number
  notionalBasisInr: number
}

/** Mirrors the server's RejectionCode — see server/tradingService.ts. */
export type RejectionCode =
  | 'no_active_round'
  | 'unknown_instrument'
  | 'invalid_qty'
  | 'invalid_side'
  | 'invalid_leverage'
  | 'missing_limit_price'
  | 'no_reference_price'
  | 'insufficient_margin'

/** Structured detail behind a rejection, so the UI can explain it with numbers. */
export interface OrderRejection {
  code: RejectionCode
  requiredInr?: number
  availableInr?: number
  ticker?: string
}

export interface PlaceOrderResult {
  accepted: boolean
  reason?: string
  /** Present only when `accepted` is false. */
  rejection?: OrderRejection
  orderId?: string
  status?: string
  remainingQty?: number
  trades?: { price: number; qty: number }[]
  /**
   * Top-of-book on the far side immediately before this order matched — best ask
   * for a buy, best bid for a sell. MARKET orders only, absent when that side was
   * empty. Measured server-side at match time, so the slippage nudge does not
   * depend on a possibly-stale depth poll.
   */
  bestPriceAtSubmit?: number
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = session.accessToken()
  return token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Expired-session (401) handling — shared by every request, so all polling
// pages (/terminal, /portfolio, /news, /leaderboard) recover identically.
// ---------------------------------------------------------------------------

let redirectingToLogin = false
/**
 * Hard-navigate to /login. A full navigation is deliberate: it clears all stale
 * in-memory + polling state and drops the team on a clean sign-in. Guarded so a
 * burst of concurrent 401s only redirects once.
 */
export function forceLogin(): void {
  if (redirectingToLogin) return
  redirectingToLogin = true
  window.location.replace('/login')
}

let refreshInFlight: Promise<boolean> | null = null
/**
 * Attempt ONE Supabase access-token refresh, de-duped across concurrent callers
 * (e.g. the News page fires three polls at once — they share a single refresh).
 * Resolves true if a valid session came back.
 */
function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  const token = session.refreshToken()
  if (!token) return Promise.resolve(false)
  refreshInFlight = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ refreshToken: token }),
  })
    .then(async (r) => {
      if (!r.ok) return false
      const t = (await r.json()) as session.TokenPair
      if (!t?.accessToken || !t?.refreshToken) return false
      // Supabase ROTATES the refresh token: persist the new pair, or the next
      // refresh spends a token the server has already invalidated.
      session.saveTokens(t)
      return true
    })
    .catch(() => false)
  void refreshInFlight.finally(() => { refreshInFlight = null })
  return refreshInFlight
}

/**
 * GET with a few quick retries on TRANSIENT failures — a dropped connection
 * (fetch rejects) or a 5xx — so a brief mid-event network hiccup is absorbed
 * before the caller (polling loop, portfolio, etc.) ever sees it. A 4xx is a
 * real client error and is surfaced immediately. A 401 specifically means the
 * session expired: we refresh the token ONCE and retry, and if that fails we
 * send the user to /login rather than letting the page hang on "Reconnecting…".
 */
async function get<T>(path: string, tries = 3): Promise<T> {
  let lastErr: unknown
  let triedRefresh = false
  for (let attempt = 0; attempt < tries; attempt++) {
    let res: Response | null = null
    try {
      // `no-store`: never serve a trading read from the HTTP cache. The server
      // sends no-store too; this is the half we control when an intermediary
      // does not honour it.
      res = await fetch(`/api${path}`, { headers: await authHeaders(), cache: 'no-store' })
    } catch (err) {
      lastErr = err // network/connection error → transient, retry
    }
    if (res) {
      if (res.ok) return (await res.json()) as T
      if (res.status === 401) {
        // Expired/invalid session: refresh once and retry with the fresh token;
        // if the refresh fails (or the retry still 401s), the session is dead.
        if (!triedRefresh && (await tryRefresh())) {
          triedRefresh = true
          continue // re-fetch immediately; authHeaders() picks up the new token
        }
        forceLogin()
        throw new Error(`GET ${path} → 401`)
      }
      if (res.status < 500) throw new Error(`GET ${path} → ${res.status}`) // other 4xx: don't retry
      lastErr = new Error(`GET ${path} → ${res.status}`) // 5xx: transient, retry
    }
    if (attempt < tries - 1) await sleep(200 * (attempt + 1)) // 200ms, then 400ms
  }
  throw lastErr
}

/**
 * POST is deliberately single-shot and NEVER auto-retried for a network/5xx
 * failure: a failed write may have actually landed (response lost in transit),
 * so a blind retry risks a duplicate order. A 401 is the ONE safe exception —
 * it's rejected at the auth gate before the write is processed — so on 401 we
 * refresh + retry once, then fall back to /login.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  let res = await fetch(`/api${path}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
  if (res.status === 401) {
    if (await tryRefresh()) {
      res = await fetch(`/api${path}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
    }
    if (res.status === 401) { forceLogin(); throw new Error(`POST ${path} → 401`) }
  }
  if (!res.ok) {
    // Surface the server's own reason when it sends one ({ error: '...' }), so
    // callers can show a real explanation instead of a bare status code.
    const reason = await res
      .json()
      .then((b) => (b as { error?: string } | null)?.error)
      .catch(() => undefined)
    throw new Error(reason ? String(reason) : `POST ${path} → ${res.status}`)
  }
  return res.json() as Promise<T>
}

/**
 * Guarantee the Portfolio's array fields are arrays.
 *
 * `get<Portfolio>` ends in `as T` — a compile-time CAST with no runtime check —
 * so TypeScript's promise that `workingOrders` exists is worth nothing against
 * an actual response. A server running a build older than the field (a process
 * that did not restart on deploy, say) returns JSON without it, and the page
 * dies on `.length` before it renders a single row.
 *
 * Normalising here means one place decides, instead of every consumer having to
 * remember. All three arrays are covered, not just the one that crashed:
 * `inventory` and `tradeHistory` are read exactly the same way.
 */
export function normalizePortfolio(p: Portfolio): Portfolio {
  return {
    ...p,
    inventory: Array.isArray(p?.inventory) ? p.inventory : [],
    workingOrders: Array.isArray(p?.workingOrders) ? p.workingOrders : [],
    tradeHistory: Array.isArray(p?.tradeHistory) ? p.tradeHistory : [],
  }
}

export const api = {
  /** Exchange credentials for tokens. The browser holds no Supabase key. */
  login: (username: string, password: string) =>
    post<session.Session>('/auth/login', { username, password }),
  /** Best-effort server-side revoke; the caller clears local storage regardless. */
  logout: () => post<{ ok: true }>('/auth/logout', {}),

  bootstrap: () => get<Bootstrap>('/bootstrap'),
  snapshot: (ticker: string | null, priceWindowSec: number) =>
    get<Snapshot>(`/snapshot?ticker=${encodeURIComponent(ticker ?? '')}&priceWindowSec=${priceWindowSec}`),
  placeOrder: (input: PlaceOrderInput) => post<PlaceOrderResult>('/orders', input),
  cancelOrder: (orderId: string) => post<{ cancelled: boolean }>('/orders/cancel', { orderId }),
  portfolio: async () => normalizePortfolio(await get<Portfolio>('/portfolio')),

  // Market-maker only. Both 403 for any other role.
  /** Positions currently past their liquidation threshold. Read-only. */
  liquidations: async () => (await get<{ positions: LiquidatableRow[] }>('/liquidations')).positions ?? [],
  /** Force-close one position at market. Never automatic — this is the button. */
  liquidate: (accountId: string, ticker: string) =>
    post<{ applied: boolean; event?: unknown }>('/liquidations/close', { accountId, ticker }),
  leaderboard: () => get<{ leaderboard: LeaderboardEntry[] }>('/leaderboard'),

  // Master Terminal
  roundStart: () => post<{ round: RoundStatus }>('/round/start', {}),
  roundEnd: () => post<{ round: RoundStatus }>('/round/end', {}),
  setCommission: (enabled: boolean) => post<{ round: RoundStatus }>('/round/commission', { enabled }),
  /**
   * Master-only. Pins the USD→INR settlement rate on the active round, or the
   * next pending one when none is active. Allowed at any time, including
   * mid-round: the change applies to subsequent fills only, and trades that have
   * already settled keep the rate they settled at.
   */
  setUsdInrRate: (usdInrRate: number) =>
    post<{ round: RoundStatus; changed: ScheduleRound | null }>('/round/rate', { usdInrRate }),
  /**
   * Master-only. Sets the commission rate (fraction of notional per side) on the
   * active round, or the next pending one when none is active. Changeable at any
   * time, including mid-round: forward-only, and each fill records the rate it
   * was charged at, so already-settled fills are never recomputed.
   */
  setCommissionRate: (commissionRate: number) =>
    post<{ round: RoundStatus; changed: ScheduleRound | null }>('/round/commission-rate', { commissionRate }),
  /**
   * Master-only. Shows or hides the slippage nudge for the active round (or the
   * next pending one). Display-only: never affects matching, fills or settlement.
   */
  setSlippageEnabled: (enabled: boolean) =>
    post<{ round: RoundStatus; changed: ScheduleRound | null }>('/round/slippage', { enabled }),
  roundSchedule: () => get<{ schedule: ScheduleRound[] }>('/round/schedule'),
  notificationsList: () => get<{ notifications: Notification[] }>('/notifications'),
  pushNotification: (kind: Notification['kind'], title: string, body?: string) =>
    post<{ ok: boolean }>('/notifications', { kind, title, body }),
  adminTeams: () => get<{ teams: TeamOverview[] }>('/admin/teams'),
  /**
   * Master-only. DESTRUCTIVE: clears every trade, order and position, zeroes all
   * realized P&L (restoring cash to starting_cash) and returns the round schedule
   * to all-pending. Accounts, instruments and the audit log are preserved.
   * Requires the literal confirmation string, checked server-side too.
   */
  resetEvent: () => post<ResetEventResult>('/admin/reset', { confirm: 'RESET' }),
  /**
   * Master-only. Sets instrument starting prices for the upcoming round. Usable
   * before every round, not just the first. Rejects (throwing the server's
   * reason) while a round is active, and is all-or-nothing across the batch.
   */
  setInstrumentPrices: (prices: { ticker: string; price: number }[]) =>
    post<SetInstrumentPricesResult>('/instruments/price', { prices }),
}
