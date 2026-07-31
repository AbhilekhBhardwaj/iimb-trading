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
  t: number
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

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: await authHeaders() })
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(body) })
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
}
