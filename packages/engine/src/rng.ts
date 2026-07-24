/**
 * Deterministic, seedable PRNG.
 *
 * We deliberately avoid Math.random() so that a given seed always replays the
 * exact same market. That reproducibility is what makes the simulation testable
 * and lets a facilitator rehearse an event before running it live.
 */

export interface Rng {
  /** Next uniform float in [0, 1). */
  next(): number
  /** Next draw from the standard normal distribution N(0, 1). */
  normal(): number
}

/**
 * mulberry32: a compact, fast 32-bit PRNG with good statistical properties for
 * simulation use. Its entire state is a single 32-bit integer seeded below.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Create a seeded RNG. The same seed produces an identical stream of
 * next()/normal() values, in call order.
 */
export function createRng(seed: number): Rng {
  const uniform = mulberry32(seed)
  return {
    next: uniform,
    normal(): number {
      // Box–Muller transform. Guard u1 away from 0 so log(0) = -Infinity never
      // occurs; u1 is drawn until it is strictly positive.
      let u1 = 0
      while (u1 === 0) u1 = uniform()
      const u2 = uniform()
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    },
  }
}
