import { describe, it, expect } from 'vitest'
import {
  createEventConfig,
  DEFAULT_USD_INR_RATE,
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

describe('RoundController — setCommission (Master control)', () => {
  it('toggles commission on the active round when one is active', () => {
    const rc = new RoundController(threeRoundConfig())
    rc.startNextRound(0) // round 'a' active, commission false
    const changed = rc.setCommission(true)
    expect(changed?.id).toBe('a')
    expect(changed?.commissionEnabled).toBe(true)
    expect(rc.getCurrentRound()?.commissionEnabled).toBe(true)
    expect(rc.isCommissionActive()).toBe(true)
  })

  it('targets the next pending round when none is active', () => {
    const rc = new RoundController(threeRoundConfig())
    // nothing active yet → affects the first pending round ('a')
    const changed = rc.setCommission(true)
    expect(changed?.id).toBe('a')
    expect(rc.getSchedule()[0].commissionEnabled).toBe(true)
    // after 'a' ends, the next pending ('b') is targeted
    rc.startNextRound(0)
    rc.endCurrentRound(10)
    const next = rc.setCommission(false)
    expect(next?.id).toBe('b')
    expect(rc.getSchedule()[1].commissionEnabled).toBe(false)
  })

  it('returns null when there is neither an active nor a pending round', () => {
    const rc = new RoundController([{ id: 'only', mode: 'silent', durationSeconds: 60, commissionEnabled: false }])
    rc.startNextRound(0)
    rc.endCurrentRound(60) // no pending left, none active
    expect(rc.setCommission(true)).toBeNull()
  })
})

describe('RoundController — pinned USD/INR rate (decision 5)', () => {
  it('defaults every round to the default rate and never moves it on its own', () => {
    const rc = new RoundController(threeRoundConfig())
    expect(rc.getSchedule().map((r) => r.usdInrRate)).toEqual([
      DEFAULT_USD_INR_RATE,
      DEFAULT_USD_INR_RATE,
      DEFAULT_USD_INR_RATE,
    ])

    rc.startNextRound(0)
    const before = rc.getUsdInrRate()
    // Time passing must not drift the rate — it is pinned, not a market price.
    rc.advanceTime(100)
    rc.advanceTime(200)
    expect(rc.getUsdInrRate()).toBe(before)
  })

  it('is null between rounds', () => {
    const rc = new RoundController(threeRoundConfig())
    expect(rc.getUsdInrRate()).toBeNull()
    rc.startNextRound(0)
    expect(rc.getUsdInrRate()).toBe(DEFAULT_USD_INR_RATE)
    rc.endCurrentRound(10)
    expect(rc.getUsdInrRate()).toBeNull()
  })

  it('honours a per-round rate from the config', () => {
    const rc = new RoundController([
      { id: 'a', mode: 'silent', durationSeconds: 60, commissionEnabled: false, usdInrRate: 90 },
    ])
    rc.startNextRound(0)
    expect(rc.getUsdInrRate()).toBe(90)
  })

  it('setUsdInrRate targets the active round, else the next pending one', () => {
    const rc = new RoundController(threeRoundConfig())

    // No round active → targets the first pending.
    expect(rc.setUsdInrRate(88)?.id).toBe('a')
    expect(rc.getSchedule()[0].usdInrRate).toBe(88)

    rc.startNextRound(0)
    expect(rc.getUsdInrRate()).toBe(88)

    // Active → targets the active round.
    expect(rc.setUsdInrRate(91)?.id).toBe('a')
    expect(rc.getUsdInrRate()).toBe(91)
    expect(rc.getSchedule()[1].usdInrRate).toBe(DEFAULT_USD_INR_RATE) // untouched
  })

  it('a mid-round change applies from that point on, leaving other rounds alone', () => {
    const rc = new RoundController(threeRoundConfig())
    rc.startNextRound(0)
    rc.setUsdInrRate(95)
    rc.endCurrentRound(300)

    // The ended round keeps the rate it was changed to; the next starts at default.
    expect(rc.getSchedule()[0].usdInrRate).toBe(95)
    rc.startNextRound(300)
    expect(rc.getUsdInrRate()).toBe(DEFAULT_USD_INR_RATE)
  })

  it('rejects a non-positive or non-finite rate', () => {
    const rc = new RoundController(threeRoundConfig())
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rc.setUsdInrRate(bad)).toThrow(/positive number/)
    }
  })

  it('rejects a non-positive rate in the constructor config', () => {
    expect(
      () => new RoundController([{ mode: 'silent', durationSeconds: 60, commissionEnabled: false, usdInrRate: 0 }]),
    ).toThrow(/usdInrRate must be positive/)
  })

  it('returns null when there is neither an active nor a pending round', () => {
    const rc = new RoundController([{ id: 'only', mode: 'silent', durationSeconds: 60, commissionEnabled: false }])
    rc.startNextRound(0)
    rc.endCurrentRound(60)
    expect(rc.setUsdInrRate(90)).toBeNull()
  })

  it('createEventConfig pins every round, with per-round override', () => {
    const config = createEventConfig(
      [
        { mode: 'only_data', commissionEnabled: false },
        { mode: 'silent', commissionEnabled: true, usdInrRate: 92 },
      ],
      { mockRounds: 1, usdInrRate: 86 },
    )
    expect(config.map((r) => r.usdInrRate)).toEqual([86, 86, 92])
  })
})

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

  it('startNextRound EXTENDS the schedule once no pending rounds remain', () => {
    const rc = new RoundController([
      { id: 'real-1', mode: 'silent', durationSeconds: 100, commissionEnabled: false },
    ])
    rc.startNextRound(0)
    rc.advanceTime(100)

    // Used to throw; now it appends and starts a fresh round.
    const extra = rc.startNextRound(100)
    expect(extra.id).toBe('real-2')
    expect(rc.getSchedule()).toHaveLength(2)
    expect(rc.getCurrentRound()?.id).toBe('real-2')
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

    // Everything ended, nothing active.
    expect(rc.getCurrentRound()).toBeNull()
    expect(rc.getSchedule().every((r) => r.status === 'ended')).toBe(true)
    expect(rc.getSchedule()).toHaveLength(total)

    // And the schedule can still be extended past its configured end.
    const extra = rc.startNextRound(clock)
    expect(extra.id).toBe('real-8') // 7 real rounds configured → next is real-8
    expect(rc.getSchedule()).toHaveLength(total + 1)
  })
})

describe('RoundController — extending the schedule past its configured end', () => {
  /** The standard event: mock-1, real-1, real-2, real-3. */
  function standardEvent(): RoundController {
    return new RoundController(
      createEventConfig(
        [
          { mode: 'data_and_news', commissionEnabled: false },
          { mode: 'only_data', commissionEnabled: true },
          { mode: 'silent', commissionEnabled: true },
        ],
        { mockRounds: 1, mockDurationSeconds: 300, realDurationSeconds: 600 },
      ),
    )
  }

  /** Run every pending round to completion, returning the clock. */
  function drain(rc: RoundController, clock = 0): number {
    let t = clock
    while (rc.getSchedule().some((r) => r.status === 'pending')) {
      const r = rc.startNextRound(t)
      t += r.durationSeconds
      rc.advanceTime(t)
    }
    return t
  }

  it('the original four behave exactly as before', () => {
    const rc = standardEvent()
    expect(rc.getSchedule().map((r) => r.id)).toEqual(['mock-1', 'real-1', 'real-2', 'real-3'])

    let t = 0
    for (const id of ['mock-1', 'real-1', 'real-2', 'real-3']) {
      const r = rc.startNextRound(t)
      expect(r.id).toBe(id) // no extension while pending rounds remain
      t += r.durationSeconds
      rc.advanceTime(t)
    }
    expect(rc.getSchedule()).toHaveLength(4)
  })

  it('starting a 5th round creates real-4', () => {
    const rc = standardEvent()
    const t = drain(rc)

    const fifth = rc.startNextRound(t)
    expect(fifth.id).toBe('real-4')
    expect(fifth.index).toBe(4)
    expect(fifth.status).toBe('active')
    expect(rc.getCurrentRound()?.id).toBe('real-4')
  })

  it('works repeatedly — 5th, 6th, 7th, 8th', () => {
    const rc = standardEvent()
    let t = drain(rc)

    for (const expected of ['real-4', 'real-5', 'real-6', 'real-7']) {
      const r = rc.startNextRound(t)
      expect(r.id).toBe(expected)
      t += r.durationSeconds
      rc.advanceTime(t)
    }
    expect(rc.getSchedule()).toHaveLength(8)
    expect(rc.getSchedule().map((r) => r.id)).toEqual([
      'mock-1', 'real-1', 'real-2', 'real-3', 'real-4', 'real-5', 'real-6', 'real-7',
    ])
  })

  it('an extension round inherits the LAST REAL round settings, not the mock', () => {
    const rc = standardEvent()
    const t = drain(rc)
    const fifth = rc.startNextRound(t)

    // real-3 is silent / 600s / commission on — mock-1 is data_and_news / 300s / off.
    expect(fifth.mode).toBe('silent')
    expect(fifth.durationSeconds).toBe(600)
    expect(fifth.commissionEnabled).toBe(true)
  })

  it('carries the Master-set FX and commission rates forward', () => {
    const rc = standardEvent()
    drain(rc)
    rc.setUsdInrRate(91) // lands on the next pending round… none, so nothing yet
    const t = 10_000

    const fifth = rc.startNextRound(t)
    expect(fifth.usdInrRate).toBe(83) // inherited from real-3, untouched
    rc.setUsdInrRate(91) // now targets the ACTIVE extension round
    expect(rc.getUsdInrRate()).toBe(91)
    rc.advanceTime(t + fifth.durationSeconds)

    const sixth = rc.startNextRound(t + fifth.durationSeconds)
    expect(sixth.id).toBe('real-5')
    expect(sixth.usdInrRate).toBe(91) // inherited from the round before it
  })

  it('never reuses an id, and numbering ignores mock rounds', () => {
    const rc = new RoundController(
      createEventConfig([{ mode: 'silent', commissionEnabled: false }], { mockRounds: 3 }),
    )
    expect(rc.getSchedule().map((r) => r.id)).toEqual(['mock-1', 'mock-2', 'mock-3', 'real-1'])
    const t = drain(rc)
    expect(rc.startNextRound(t).id).toBe('real-2') // not real-5
  })

  it('still refuses to start while a round is active', () => {
    const rc = standardEvent()
    const t = drain(rc)
    rc.startNextRound(t)
    expect(() => rc.startNextRound(t + 1)).toThrow(/already active/)
  })

  it('an all-mock schedule extends with a real round', () => {
    const rc = new RoundController([
      { id: 'mock-1', mode: 'data_and_news', durationSeconds: 300, commissionEnabled: false },
    ])
    const t = drain(rc)
    const next = rc.startNextRound(t)
    expect(next.id).toBe('real-1')
    expect(next.durationSeconds).toBe(300) // falls back to the last round of any kind
  })
})
