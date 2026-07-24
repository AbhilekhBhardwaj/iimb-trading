/**
 * Live market simulation — the terminal's data layer.
 *
 * This is a thin driver around the REAL, tested @iimb-trading/engine:
 *   - price.ts  : GBM step + driftTowardStep (mean-reverting news absorption)
 *   - news.ts   : per-item target deltas (primary / related / sector / market)
 *   - rng.ts    : seedable deterministic RNG (same seed => same market)
 *
 * PRICE MODEL — how a headline is absorbed over time:
 *   1. FREEZE   : for the first NEWS_WINDOW_SECONDS (30s) after a headline that
 *                 affects a stock, that stock's price is held EXACTLY flat (the
 *                 reaction window — traders digest the news, price hasn't moved).
 *   2. ABSORB   : for the next NEWS_ABSORB_SECONDS the price meanders toward the
 *                 news target via the engine's driftTowardStep — small GBM noise
 *                 (per-stock vol) for a realistic up/down wiggle, ON TOP OF a
 *                 drift that leans toward target each tick. It wanders but trends
 *                 to the target, reaching it gradually (no ramp, no snap).
 *   3. SETTLE   : once absorbed (and between events) the price simply holds — it
 *                 has already drifted to ~target, so it rests there, static.
 *
 * Targets compose: a stock hit by several headlines drifts toward the SUM of
 * their deltas. The baseline (start) price is the reference; a target is
 * start * (1 + sum of settled-in deltas).
 */
import { useEffect, useRef, useState } from 'react'
import {
  createRng,
  driftTowardStep,
  dtYears,
  NEWS_WINDOW_SECONDS,
  stockTargetDelta,
  type NewsItem,
  type Rng,
  type Stock,
} from '@iimb-trading/engine'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Fixed seed => the market replays identically every run (engine determinism). */
const SEED = 20260724

/** Real seconds between ticks. Also the unit for the news event timeline. */
export const TICK_SECONDS = 1

/** How long, after the 30s freeze, a stock spends drifting toward the target. */
export const NEWS_ABSORB_SECONDS = 120

/** Fraction of the remaining log-gap to target closed per tick (before noise). */
const NEWS_REVERSION = 0.025

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

/**
 * The 10 tradable instruments. `vol` here is the small annualized amplitude of
 * the up/down WIGGLE applied only while a stock is absorbing news — between and
 * before events the price is held flat, so this noise never causes drift on its
 * own. More "excitable" names (TSLA, NVDA, CRUDE) wiggle a bit more.
 */
export const INITIAL_STOCKS: readonly Stock[] = [
  { ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology', price: 229.5, vol: 0.28 },
  { ticker: 'NVDA', name: 'NVIDIA Corp.', sector: 'Technology', price: 128.4, vol: 0.42 },
  { ticker: 'TSLA', name: 'Tesla Inc.', sector: 'Automotive', price: 248.9, vol: 0.5 },
  { ticker: 'AMZN', name: 'Amazon.com', sector: 'Technology', price: 186.3, vol: 0.3 },
  { ticker: 'GOOGL', name: 'Alphabet Inc.', sector: 'Technology', price: 174.2, vol: 0.3 },
  { ticker: 'META', name: 'Meta Platforms', sector: 'Technology', price: 563.7, vol: 0.35 },
  { ticker: 'SPY', name: 'S&P 500 ETF', sector: 'Index', price: 572.4, vol: 0.16 },
  { ticker: 'QQQ', name: 'Nasdaq 100 ETF', sector: 'Index', price: 486.1, vol: 0.2 },
  { ticker: 'GOLD', name: 'Gold Spot /oz', sector: 'Commodity', price: 2648.0, vol: 0.18 },
  { ticker: 'CRUDE', name: 'WTI Crude /bbl', sector: 'Energy', price: 71.2, vol: 0.4 },
]

/** Starting (t=0) price per ticker — the baseline all targets are measured from. */
const START_PRICE: Record<string, number> = Object.fromEntries(
  INITIAL_STOCKS.map((s) => [s.ticker, s.price]),
)

/**
 * Scripted news timeline. `fireAtSeconds` is on the real event timeline,
 * COMPRESSED for the demo: nominally headlines land every ~7-8 simulated
 * minutes, here spaced ~60-70s apart so 3-4 fire within a few minutes of
 * watching. Impact maps are real decimal deltas fed to the engine.
 */
export const NEWS_TIMELINE: readonly NewsItem[] = [
  {
    id: 'n1',
    headline: 'NVIDIA smashes Q3 estimates, lifts full-year guidance',
    body: 'Data-center revenue up 94% YoY; company guides well above consensus. Chipmakers and mega-cap tech bid up in sympathy.',
    fireAtSeconds: 15,
    isHerring: false,
    impact: { primary: { NVDA: 0.09 }, related: { AAPL: 0.015 }, sector: { Technology: 0.02 }, market: 0 },
  },
  {
    id: 'n2',
    headline: 'Fed signals surprise rate hike to tame sticky inflation',
    body: 'Chair strikes a hawkish tone in unscheduled remarks. Risk assets sell off broadly; gold catches a partial safe-haven bid.',
    fireAtSeconds: 80,
    isHerring: false,
    impact: { primary: { GOLD: 0.025 }, related: {}, sector: {}, market: -0.03 },
  },
  {
    id: 'n3',
    headline: 'OPEC+ announces deeper-than-expected output cut',
    body: 'Cartel trims supply beyond forecasts; crude spikes on tighter balances, dragging a little gold along with it.',
    fireAtSeconds: 150,
    isHerring: false,
    impact: { primary: { CRUDE: 0.11 }, related: { GOLD: 0.015 }, sector: {}, market: 0 },
  },
  {
    id: 'n4',
    headline: 'Tesla recalls 2M vehicles over Autopilot safety probe',
    body: 'NHTSA forces the largest recall to date. Shares slide; some read-through weakness in chip suppliers.',
    fireAtSeconds: 220,
    isHerring: false,
    impact: { primary: { TSLA: -0.1 }, related: { NVDA: -0.01 }, sector: {}, market: 0 },
  },
]

/** Whether a news item moves the given stock at all (any channel, non-herring). */
export function newsAffects(item: NewsItem, ticker: string, sector: string): boolean {
  return stockTargetDelta(item, ticker, sector) !== 0
}

// ---------------------------------------------------------------------------
// News influence on a single stock at a moment in time
// ---------------------------------------------------------------------------

const ABSORB_END = NEWS_WINDOW_SECONDS + NEWS_ABSORB_SECONDS

interface Influence {
  /** Composed settled-in target delta (headlines past their freeze window). */
  targetDelta: number
  /** A headline affecting this stock is in its 30s reaction window (freeze). */
  frozen: boolean
  /** A headline affecting this stock is actively being absorbed (drift+wiggle). */
  absorbing: boolean
}

function influenceOn(ticker: string, sector: string, elapsed: number): Influence {
  let targetDelta = 0
  let frozen = false
  let absorbing = false
  for (const item of NEWS_TIMELINE) {
    if (elapsed < item.fireAtSeconds) continue
    const delta = stockTargetDelta(item, ticker, sector)
    if (delta === 0) continue
    const s = elapsed - item.fireAtSeconds
    if (s < NEWS_WINDOW_SECONDS) {
      frozen = true // still in the reaction window — target not applied yet
      continue
    }
    targetDelta += delta // window passed => this headline's target is in effect
    if (s < ABSORB_END) absorbing = true
  }
  return { targetDelta, frozen, absorbing }
}

/**
 * Advance every stock's price one tick. Pure given (prev, elapsed, rng, dt):
 *   frozen    -> hold exactly (30s reaction freeze)
 *   absorbing -> driftTowardStep: GBM wiggle + drift toward target
 *   otherwise -> hold (already drifted to ~target; static between events)
 * Only absorbing stocks draw from the RNG, so the stream stays deterministic.
 */
export function stepPrices(prev: readonly number[], elapsed: number, rng: Rng, dt: number): number[] {
  return INITIAL_STOCKS.map((base, i) => {
    const price = prev[i]
    const inf = influenceOn(base.ticker, base.sector, elapsed)
    if (inf.frozen) return price
    if (inf.absorbing) {
      const target = START_PRICE[base.ticker] * (1 + inf.targetDelta)
      return driftTowardStep(price, target, base.vol, rng.normal(), NEWS_REVERSION, dt)
    }
    return price
  })
}

// ---------------------------------------------------------------------------
// Positions & account model (marked to the REAL live engine prices)
// ---------------------------------------------------------------------------

export type Side = 'Long' | 'Short'

export interface Position {
  id: string
  ticker: string
  side: Side
  size: number
  leverage: number
  /** Entry price in the instrument's native currency (USD). */
  entryPrice: number
}

/** USD -> INR conversion used for the account panel. */
export const USD_INR = 83

/** Wallet balance in INR before unrealized P&L. */
export const STARTING_CASH_INR = 1_000_000

/**
 * Three seeded positions. Entries sit a little off the start price so there is
 * live open P&L immediately; each is then hit by a scripted headline so the P&L
 * moves for the RIGHT reason (NVDA beat, crude cut, Tesla recall).
 */
export const SEED_POSITIONS: readonly Position[] = [
  { id: 'p1', ticker: 'NVDA', side: 'Long', size: 50, leverage: 5, entryPrice: 124.0 },
  { id: 'p2', ticker: 'TSLA', side: 'Short', size: 30, leverage: 3, entryPrice: 255.0 },
  { id: 'p3', ticker: 'CRUDE', side: 'Long', size: 100, leverage: 10, entryPrice: 73.5 },
]

/** Unrealized P&L in USD for a position at the given live price. */
export function positionPnlUsd(p: Position, price: number): number {
  const dir = p.side === 'Long' ? 1 : -1
  return (price - p.entryPrice) * p.size * dir
}

/** Notional (position value) in USD at entry. */
export function notionalUsd(p: Position): number {
  return p.entryPrice * p.size
}

/** Margin posted in USD (isolated): notional / leverage. */
export function marginUsedUsd(p: Position): number {
  return notionalUsd(p) / p.leverage
}

/**
 * Simplified isolated-margin liquidation price: the position is wiped when an
 * adverse move erodes the posted margin, i.e. a move of 1/leverage against you.
 * (No fees / maintenance-margin buffer — this is a demo terminal.)
 */
export function liquidationPrice(entry: number, leverage: number, side: Side): number {
  return side === 'Long' ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage)
}

/**
 * Liquidation "health" in [0,1]: 1 = at/above entry (safe), 0 = at the
 * liquidation price. Used to color a position by how close it is to being wiped.
 */
export function liquidationHealth(p: Position, price: number): number {
  const liq = liquidationPrice(p.entryPrice, p.leverage, p.side)
  const raw =
    p.side === 'Long'
      ? (price - liq) / (p.entryPrice - liq)
      : (liq - price) / (liq - p.entryPrice)
  return Math.max(0, Math.min(1, raw))
}

// ---------------------------------------------------------------------------
// Live frame produced each tick
// ---------------------------------------------------------------------------

export interface DisplayStock {
  ticker: string
  name: string
  sector: string
  price: number
  /** % change vs the t=0 start price. */
  pct: number
  /** Being actively absorbed right now — price is on the move (drift + wiggle). */
  moving: boolean
  /** In its 30s reaction window (price frozen, move imminent). */
  reacting: boolean
}

/** Wide-format price history: one row per tick, price per ticker. */
export type PricePoint = { t: number } & Record<string, number>

export type NewsPhase = 'reaction' | 'absorbing' | 'settled'

export interface FiredNews {
  item: NewsItem
  phase: NewsPhase
  secondsSinceFire: number
}

export interface Frame {
  elapsed: number
  stocks: DisplayStock[]
  history: PricePoint[]
  /** Fired headlines, most recent first. */
  fired: FiredNews[]
  /** The next headline yet to fire, with a countdown, or null if none remain. */
  next: { item: NewsItem; countdown: number } | null
  /** A headline currently inside its 30s reaction window (price frozen), if any. */
  reaction: FiredNews | null
}

function phaseOf(secondsSinceFire: number): NewsPhase {
  if (secondsSinceFire < NEWS_WINDOW_SECONDS) return 'reaction'
  if (secondsSinceFire < ABSORB_END) return 'absorbing'
  return 'settled'
}

function buildDisplay(prices: readonly number[], elapsed: number): DisplayStock[] {
  return INITIAL_STOCKS.map((base, i) => {
    const inf = influenceOn(base.ticker, base.sector, elapsed)
    const price = prices[i]
    return {
      ticker: base.ticker,
      name: base.name,
      sector: base.sector,
      price,
      pct: (price / START_PRICE[base.ticker] - 1) * 100,
      moving: inf.absorbing && !inf.frozen,
      reacting: inf.frozen,
    }
  })
}

function newsStateAt(elapsed: number): Pick<Frame, 'fired' | 'next' | 'reaction'> {
  const fired: FiredNews[] = []
  let next: Frame['next'] = null
  let reaction: FiredNews | null = null

  for (const item of NEWS_TIMELINE) {
    if (elapsed >= item.fireAtSeconds) {
      const secondsSinceFire = elapsed - item.fireAtSeconds
      const fn: FiredNews = { item, secondsSinceFire, phase: phaseOf(secondsSinceFire) }
      fired.push(fn)
      if (fn.phase === 'reaction') reaction = fn
    } else if (!next) {
      next = { item, countdown: item.fireAtSeconds - elapsed }
    }
  }
  fired.reverse() // most recent first
  return { fired, next, reaction }
}

const MAX_HISTORY = 900

function pricePointFrom(prices: readonly number[], elapsed: number): PricePoint {
  const point: PricePoint = { t: elapsed }
  INITIAL_STOCKS.forEach((s, i) => {
    point[s.ticker] = prices[i]
  })
  return point
}

const INITIAL_PRICES: number[] = INITIAL_STOCKS.map((s) => s.price)

/**
 * Drives the engine on a real-time interval and returns the current frame.
 * One RNG instance is reused across ticks so the wiggle stream is exactly the
 * deterministic stream the engine tests exercise.
 */
export function useSimulation(): Frame {
  const rngRef = useRef<Rng | null>(null)
  const pricesRef = useRef<number[]>([...INITIAL_PRICES])
  const elapsedRef = useRef(0)
  const historyRef = useRef<PricePoint[]>([pricePointFrom(INITIAL_PRICES, 0)])
  const [frame, setFrame] = useState<Frame>(() => ({
    elapsed: 0,
    stocks: buildDisplay(INITIAL_PRICES, 0),
    history: historyRef.current,
    ...newsStateAt(0),
  }))

  useEffect(() => {
    rngRef.current = createRng(SEED)
    const dt = dtYears(TICK_SECONDS)

    const id = window.setInterval(() => {
      elapsedRef.current += TICK_SECONDS
      const elapsed = elapsedRef.current
      pricesRef.current = stepPrices(pricesRef.current, elapsed, rngRef.current!, dt)

      const nextHistory = [...historyRef.current, pricePointFrom(pricesRef.current, elapsed)]
      if (nextHistory.length > MAX_HISTORY) nextHistory.shift()
      historyRef.current = nextHistory

      setFrame({
        elapsed,
        stocks: buildDisplay(pricesRef.current, elapsed),
        history: nextHistory,
        ...newsStateAt(elapsed),
      })
    }, TICK_SECONDS * 1000)

    return () => window.clearInterval(id)
  }, [])

  return frame
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const inrFmt0 = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** Indian-grouped rupee string (e.g. ₹10,24,500). */
export function inr(v: number): string {
  return inrFmt0.format(v)
}

/** Signed rupee string for P&L (e.g. +₹12,340 / −₹4,120). */
export function inrSigned(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${inrFmt0.format(Math.abs(v))}`
}

/** USD price string (e.g. $128.40). */
export function usd(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Compact USD for axis ticks (e.g. $2,648 / $71.2). */
export function usdAxis(v: number): string {
  return v >= 100
    ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${v.toFixed(1)}`
}

/** Signed percent string (e.g. +2.41% / −1.08%). */
export function pct(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${Math.abs(v).toFixed(2)}%`
}

/** Seconds -> m:ss clock. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
