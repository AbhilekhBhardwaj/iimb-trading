import { DEFAULT_DT_YEARS } from './config'
import type { Rng } from './rng'

export interface Stock {
  ticker: string
  name: string
  sector: string
  price: number
  /** Annualized volatility. 0.5 = 50% annualized. */
  vol: number
}

/**
 * Drift term (annualized). Zero for the base simulation: we want prices to move
 * purely from volatility, with no built-in upward or downward bias.
 */
export const DEFAULT_MU = 0

/**
 * One geometric Brownian motion step:
 *
 *   S_next = S * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z)
 *
 * Pure function — all randomness enters through Z. Since the price is only ever
 * multiplied by a strictly positive exp(...), a GBM price can never reach or
 * cross zero.
 */
export function gbmStep(
  price: number,
  vol: number,
  z: number,
  dt: number = DEFAULT_DT_YEARS,
  mu: number = DEFAULT_MU,
): number {
  const drift = (mu - (vol * vol) / 2) * dt
  const diffusion = vol * Math.sqrt(dt) * z
  return price * Math.exp(drift + diffusion)
}

/**
 * Advance a single stock by one tick, drawing its shock Z from the seeded RNG.
 * Returns a new Stock; the input is not mutated.
 */
export function tickStock(
  stock: Stock,
  rng: Rng,
  dt: number = DEFAULT_DT_YEARS,
  mu: number = DEFAULT_MU,
): Stock {
  const z = rng.normal()
  return { ...stock, price: gbmStep(stock.price, stock.vol, z, dt, mu) }
}

/**
 * Advance every stock by one tick. Each stock draws its own independent shock
 * from the shared RNG, in array order, so the result is fully deterministic for
 * a given seed and stock ordering.
 */
export function advance(
  stocks: readonly Stock[],
  rng: Rng,
  dt: number = DEFAULT_DT_YEARS,
  mu: number = DEFAULT_MU,
): Stock[] {
  return stocks.map((s) => tickStock(s, rng, dt, mu))
}
