import { describe, it, expect } from 'vitest'
import { createRng, mulberry32 } from '../src/rng'

describe('mulberry32 / createRng', () => {
  it('is deterministic: same seed produces an identical uniform stream', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    const seqA = Array.from({ length: 100 }, () => a())
    const seqB = Array.from({ length: 100 }, () => b())
    expect(seqA).toEqual(seqB)
  })

  it('different seeds produce different streams', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const seqA = Array.from({ length: 100 }, () => a())
    const seqB = Array.from({ length: 100 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })

  it('produces uniforms in [0, 1)', () => {
    const r = mulberry32(999)
    for (let i = 0; i < 10000; i++) {
      const x = r()
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThan(1)
    }
  })

  it('normal() has ~0 mean and ~1 std dev over many draws', () => {
    const rng = createRng(42)
    const n = 100000
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      const z = rng.normal()
      sum += z
      sumSq += z * z
    }
    const mean = sum / n
    const variance = sumSq / n - mean * mean
    expect(Math.abs(mean)).toBeLessThan(0.02)
    expect(Math.abs(Math.sqrt(variance) - 1)).toBeLessThan(0.02)
  })
})
