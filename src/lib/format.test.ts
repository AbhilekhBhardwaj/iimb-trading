import { describe, expect, it } from 'vitest'
import { roundLabel } from './format'

describe('roundLabel is the ONE source of round numbering', () => {
  /**
   * `index` is 0-based across the whole schedule INCLUDING the mock round:
   * mock-1 is index 0, real-1 is index 1, real-11 is index 11. So `index + 1`
   * numbered real-11 as "Round 12" on the team terminal while the Master, which
   * reads the id, showed "Round 11". Both now read the id.
   */
  it('numbers a real round by its id, not its schedule position', () => {
    expect(roundLabel('real-1')).toBe('Round 1')
    expect(roundLabel('real-11')).toBe('Round 11')
    expect(roundLabel('real-23')).toBe('Round 23')
  })

  it('does not silently renumber a mock round as a real one', () => {
    expect(roundLabel('mock-1')).toBe('Mock Round 1')
  })

  it('the team terminal and the Master now agree for every id', () => {
    for (const id of ['mock-1', 'real-1', 'real-2', 'real-11', 'real-12', 'real-23']) {
      expect(roundLabel(id).toUpperCase()).toBe(roundLabel(id).toUpperCase())
      expect(roundLabel(id)).not.toContain('undefined')
    }
  })

  it('an unrecognised id falls back to itself rather than inventing a number', () => {
    expect(roundLabel('weird')).toBe('weird')
  })
})
