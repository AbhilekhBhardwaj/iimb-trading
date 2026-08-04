/**
 * Typed client for the engine API server (server/api.ts), reached same-origin at
 * /api via the Vite dev proxy. Every call attaches the logged-in user's Supabase
 * access token; the server verifies it and derives the account + role.
 */
import { supabase } from './supabase'

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
  marginUsedInr: number
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
  qty: number
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

export interface InventoryRow {
  index: number
  ticker: string
  name: string
  ltp: number
  qty: number | null
  leverage: number | null
  avgPrice: number | null
  avgEntryInr: number | null
  currentPriceInr: number | null
  pnlM2mInr: number | null
  portfolioValueInr: number | null
  costBasisInr: number | null
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

export interface Portfolio {
  rate: number
  openingBalanceInr: number
  realizedPnlUsd: number
  realizedPnlInr: number
  cashInr: number
  inventory: InventoryRow[]
  positionsValueInr: number
  unrealizedPnlInr: number
  totalPnlInr: number
  totalPnlPct: number
  totalPortfolioValueInr: number
  xirr: number | null
  leverageReq: number
  openPositions: number
  chargesInr: number
  tradeHistory: TradeHistoryEntry[]
}

export interface Snapshot {
  round: RoundStatus
  account: AccountState
  instruments: InstrumentRow[]
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

export interface PlaceOrderResult {
  accepted: boolean
  reason?: string
  orderId?: string
  status?: string
  remainingQty?: number
  trades?: { price: number; qty: number }[]
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
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
  refreshInFlight = supabase.auth
    .refreshSession()
    .then(({ data, error }) => !error && !!data.session)
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
      res = await fetch(`/api${path}`, { headers: await authHeaders() })
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
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  bootstrap: () => get<Bootstrap>('/bootstrap'),
  snapshot: (ticker: string | null, priceWindowSec: number) =>
    get<Snapshot>(`/snapshot?ticker=${encodeURIComponent(ticker ?? '')}&priceWindowSec=${priceWindowSec}`),
  placeOrder: (input: PlaceOrderInput) => post<PlaceOrderResult>('/orders', input),
  cancelOrder: (orderId: string) => post<{ cancelled: boolean }>('/orders/cancel', { orderId }),
  portfolio: () => get<Portfolio>('/portfolio'),
  leaderboard: () => get<{ leaderboard: LeaderboardEntry[] }>('/leaderboard'),

  // Master Terminal
  roundStart: () => post<{ round: RoundStatus }>('/round/start', {}),
  roundEnd: () => post<{ round: RoundStatus }>('/round/end', {}),
  setCommission: (enabled: boolean) => post<{ round: RoundStatus }>('/round/commission', { enabled }),
  roundSchedule: () => get<{ schedule: ScheduleRound[] }>('/round/schedule'),
  notificationsList: () => get<{ notifications: Notification[] }>('/notifications'),
  pushNotification: (kind: Notification['kind'], title: string, body?: string) =>
    post<{ ok: boolean }>('/notifications', { kind, title, body }),
  adminTeams: () => get<{ teams: TeamOverview[] }>('/admin/teams'),
}
