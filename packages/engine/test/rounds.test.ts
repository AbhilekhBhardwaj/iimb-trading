import { describe, it, expect } from 'vitest'
import {
  createEventConfig,
  RoundController,
  type EventConfig,
  type RoundMode,
} from '../src/rounds'

/** A small 3-round config with distinct modes/commission for precise assertions. */
function threeRoundConfig(): EventConfig {
  return [
    { id: 'a', mode: 'data_and_news', durationSeconds: 300, commissionEnabled: false },
    { id: 'b', mode: 'only_data', durationSeconds: 600, commissionEnabled: true },
    { id: 'c', mode: 'silent', durationSeconds: 120, commissionEnabled: false },
  ]
}

describe('RoundController — activation order & single-active invariant', () => {
  it('activates rounds in order, one at a time; previous must end before next starts', () => {
    const rc = new RoundController(threeRoundConfig())

    const r1 = rc.startNextRound(0)
    expect(r1.id).toBe('a')
    expect(rc.getCurrentRound()?.id).toBe('a')

    rc.advanceTime(300) // end round a
    const r2 = rc.startNextRound(300)
    expect(r2.id).toBe('b') // next in order

    const schedule = rc.getSchedule()
    expect(schedule.map((r) => r.status)).toEqual(['ended', 'active', 'pending'])
  })

  it('startNextRound throws if a round is already active', () => {
    const rc = new RoundController(threeRoundConfig())
    rc.startNextRound(0)
    expect(() => rc.startNextRound(10)).toThrow(/already active/)
  })

  it('startNextRound throws once no pending rounds remain', () => {
    const rc = new RoundController([
      { mode: 'silent', durationSeconds: 100, commissionEnabled: false },
    ])
    rc.startNextRound(0)
    rc.advanceTime(100)
    expect(() => rc.startNextRound(100)).toThrow(/no pending rounds/)
  })
})

describe('RoundController — time advancement', () => {
  it('flags a round as ended once its duration elapses, not before', () => {
    const rc = new RoundController(threeRoundConfig())
    rc.startNextRound(100) // ends at 400

    expect(rc.advanceTime(399)).toBe(false)
    expect(rc.getCurrentRound()?.id).toBe('a') // still active

    expect(rc.advanceTime(400)).toBe(true) // exactly at endedAt -> ended
    expect(rc.getCurrentRound()).toBeNull()

    expect(rc.advanceTime(500)).toBe(false) // nothing active to end
  })

  it('endCurrentRound ends a round early and records the actual end time', () => {
    const rc = new RoundController(threeRoundConfig())
    rc.startNextRound(0) // scheduled end 300
    const ended = rc.endCurrentRound(120)

    expect(ended.status).toBe('ended')
    expect(ended.endedAt).toBe(120) // early end time, not the scheduled 300
    expect(rc.getCurrentRound()).toBeNull()
    expect(rc.getRemainingSeconds(120)).toBeNull()
  })

  it('endCurrentRound throws when no round is active', () => {
    const rc = new RoundController(threeRoundConfig())
    expect(() => rc.endCurrentRound(0)).toThrow(/no active round/)
  })
})

describe('RoundController — reads reflect the current round', () => {
  it('getRemainingSeconds counts down and is null when no round is active', () => {
    const rc = new RoundController(threeRoundConfig())
    expect(rc.getRemainingSeconds(0)).toBeNull() // before any round

    rc.startNextRound(0) // duration 300
    expect(rc.getRemainingSeconds(0)).toBe(300)
    expect(rc.getRemainingSeconds(100)).toBe(200)
    expect(rc.getRemainingSeconds(300)).toBe(0)
    expect(rc.getRemainingSeconds(999)).toBe(0) // never negative

    rc.advanceTime(300)
    expect(rc.getRemainingSeconds(300)).toBeNull() // between rounds again
  })

  it('getMode() and isCommissionActive() reflect the current round, with defaults between rounds', () => {
    const rc = new RoundController(threeRoundConfig())
    // Between rounds: sensible defaults.
    expect(rc.getMode()).toBeNull()
    expect(rc.isCommissionActive()).toBe(false)

    rc.startNextRound(0) // round a: data_and_news, no commission
    expect(rc.getMode()).toBe('data_and_news')
    expect(rc.isCommissionActive()).toBe(false)

    rc.advanceTime(300)
    rc.startNextRound(300) // round b: only_data, commission on
    expect(rc.getMode()).toBe('only_data')
    expect(rc.isCommissionActive()).toBe(true)

    rc.endCurrentRound(400)
    expect(rc.getMode()).toBeNull()
    expect(rc.isCommissionActive()).toBe(false)
  })

  it('getSchedule() reflects pending -> active -> ended transitions', () => {
    const rc = new RoundController(threeRoundConfig())
    expect(rc.getSchedule().map((r) => r.status)).toEqual(['pending', 'pending', 'pending'])

    rc.startNextRound(0)
    expect(rc.getSchedule().map((r) => r.status)).toEqual(['active', 'pending', 'pending'])

    rc.advanceTime(300)
    expect(rc.getSchedule().map((r) => r.status)).toEqual(['ended', 'pending', 'pending'])

    rc.startNextRound(300)
    expect(rc.getSchedule().map((r) => r.status)).toEqual(['ended', 'active', 'pending'])

    // Schedule returns snapshots — mutating them must not affect the controller.
    const snap = rc.getSchedule()
    snap[1].status = 'ended'
    expect(rc.getSchedule()[1].status).toBe('active')
  })
})

describe('RoundController — createEventConfig & full run', () => {
  it('createEventConfig builds mock rounds then real rounds with correct durations/modes', () => {
    const real: { mode: RoundMode; commissionEnabled: boolean }[] = [
      { mode: 'only_data', commissionEnabled: false },
      { mode: 'data_and_news', commissionEnabled: true },
    ]
    const config = createEventConfig(real)
    expect(config).toHaveLength(4) // 2 mock + 2 real (defaults)
    expect(config[0]).toMatchObject({ id: 'mock-1', durationSeconds: 300, commissionEnabled: false })
    expect(config[1]).toMatchObject({ id: 'mock-2', durationSeconds: 300 })
    expect(config[2]).toMatchObject({ id: 'real-1', mode: 'only_data', durationSeconds: 600 })
    expect(config[3]).toMatchObject({ id: 'real-2', mode: 'data_and_news', commissionEnabled: true })
  })

  it('runs the whole schedule (mock + real) and ends cleanly with no active round', () => {
    const real: { mode: RoundMode; commissionEnabled: boolean }[] = Array.from({ length: 7 }, (_, i) => ({
      mode: i % 2 === 0 ? 'data_and_news' : 'only_data',
      commissionEnabled: i >= 3, // commission kicks in for later rounds
    }))
    const rc = new RoundController(createEventConfig(real))
    const total = 2 + 7

    let clock = 0
    for (let i = 0; i < total; i++) {
      const round = rc.startNextRound(clock)
      expect(rc.getCurrentRound()?.id).toBe(round.id)
      // Advance one second short: not ended yet.
      expect(rc.advanceTime(clock + round.durationSeconds - 1)).toBe(false)
      // Reach the scheduled end: ended.
      clock += round.durationSeconds
      expect(rc.advanceTime(clock)).toBe(true)
      expect(rc.getCurrentRound()).toBeNull()
    }

    // Everything ended, nothing active, and no more rounds can start.
    expect(rc.getCurrentRound()).toBeNull()
    expect(rc.getSchedule().every((r) => r.status === 'ended')).toBe(true)
    expect(rc.getSchedule()).toHaveLength(total)
    expect(() => rc.startNextRound(clock)).toThrow(/no pending rounds/)
  })
})
