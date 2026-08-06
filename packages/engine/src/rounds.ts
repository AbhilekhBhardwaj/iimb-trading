/**
 * Event round controller.
 *
 * Pure and deterministic, like the rest of the engine: no clock, no RNG, no I/O.
 * There is NO dependency on wall-clock time or setTimeout — every method that
 * cares about "now" takes an explicit `atSecond` / `toSecond` argument, so tests
 * (and the real system) advance a virtual clock by passing numbers. The same
 * sequence of calls always produces the same schedule state.
 *
 * An event is an ordered list of rounds configured ahead of time by the Master
 * Terminal (e.g. 2 mock rounds, then 7-13 real rounds). Exactly one round is
 * ever active at a time; a round must end before the next can start. A later
 * integration layer can gate order placement on getCurrentRound()/getMode(),
 * but this module deliberately knows nothing about orders.
 */

export type RoundMode = 'data_and_news' | 'only_data' | 'silent'
export type RoundStatus = 'pending' | 'active' | 'ended'

/**
 * Fallback USD→INR rate for a round whose config doesn't pin one.
 *
 * The rate is PINNED PER ROUND and only ever changes when the Master changes it
 * (see `setUsdInrRate`). It deliberately does not drift: under INR cash
 * settlement a rate move realizes real P&L on every close, so an auto-drifting
 * rate would silently inject P&L from currency movement alone.
 *
 * Keep in sync with the server's USD_INR (server/config.ts).
 */
export const DEFAULT_USD_INR_RATE = 83

export interface Round {
  id: string
  /** 0-based position in the event schedule. */
  index: number
  mode: RoundMode
  durationSeconds: number
  commissionEnabled: boolean
  /** USD→INR rate in force for this round. Fixed unless the Master changes it. */
  usdInrRate: number
  status: RoundStatus
  /** Event-clock second the round started; null until activated. */
  startedAt: number | null
  /** Event-clock second the round ended (scheduled end, or early end); null until ended. */
  endedAt: number | null
}

/** A single round's configuration, before the event starts. */
export interface RoundDefinition {
  mode: RoundMode
  durationSeconds: number
  commissionEnabled: boolean
  /** USD→INR rate for this round; defaults to DEFAULT_USD_INR_RATE. */
  usdInrRate?: number
  /** Optional stable id; falls back to `round-<n>` by position. */
  id?: string
}

/** The ordered list of round definitions for an event. */
export type EventConfig = readonly RoundDefinition[]

export class RoundController {
  private readonly rounds: Round[]
  /** Index of the currently-active round, or null when between rounds. */
  private activeIndex: number | null = null

  constructor(config: EventConfig) {
    this.rounds = config.map((def, index) => {
      if (def.durationSeconds <= 0) {
        throw new Error(`round ${index} duration must be positive`)
      }
      if (def.usdInrRate !== undefined && def.usdInrRate <= 0) {
        throw new Error(`round ${index} usdInrRate must be positive`)
      }
      return {
        id: def.id ?? `round-${index + 1}`,
        index,
        mode: def.mode,
        durationSeconds: def.durationSeconds,
        commissionEnabled: def.commissionEnabled,
        usdInrRate: def.usdInrRate ?? DEFAULT_USD_INR_RATE,
        status: 'pending',
        startedAt: null,
        endedAt: null,
      }
    })
  }

  /**
   * Activate the next pending round at event-second `atSecond`, recording
   * startedAt and computing endedAt from its duration. Throws if a round is
   * already active (only one at a time) or if no pending rounds remain.
   */
  startNextRound(atSecond: number): Round {
    if (this.activeIndex !== null) {
      throw new Error('a round is already active; end it before starting the next')
    }
    const next = this.rounds.find((r) => r.status === 'pending')
    if (!next) throw new Error('no pending rounds remain')

    next.status = 'active'
    next.startedAt = atSecond
    next.endedAt = atSecond + next.durationSeconds
    this.activeIndex = next.index
    return snapshot(next)
  }

  /**
   * Report (and record) whether the active round has now elapsed. Marks the
   * round 'ended' and clears the active slot when `toSecond >= endedAt`,
   * returning true on that transition; returns false while still running or
   * when no round is active. This is how time "passes" without real delays.
   */
  advanceTime(toSecond: number): boolean {
    if (this.activeIndex === null) return false
    const round = this.rounds[this.activeIndex]
    if (round.endedAt !== null && toSecond >= round.endedAt) {
      round.status = 'ended'
      this.activeIndex = null
      return true
    }
    return false
  }

  /**
   * End the active round early at `atSecond` (Master Terminal manual override).
   * Sets endedAt to the actual end time. Throws if no round is active.
   */
  endCurrentRound(atSecond: number): Round {
    if (this.activeIndex === null) throw new Error('no active round to end')
    const round = this.rounds[this.activeIndex]
    round.status = 'ended'
    round.endedAt = atSecond
    this.activeIndex = null
    return snapshot(round)
  }

  /** The active round (snapshot), or null when between rounds. */
  getCurrentRound(): Round | null {
    return this.activeIndex === null ? null : snapshot(this.rounds[this.activeIndex])
  }

  /** Seconds left in the active round at `atSecond` (never negative), or null. */
  getRemainingSeconds(atSecond: number): number | null {
    if (this.activeIndex === null) return null
    const round = this.rounds[this.activeIndex]
    return Math.max(0, (round.endedAt as number) - atSecond)
  }

  /** Whether commission applies right now — false between rounds. */
  isCommissionActive(): boolean {
    return this.activeIndex === null ? false : this.rounds[this.activeIndex].commissionEnabled
  }

  /**
   * The USD→INR rate in force right now, or null between rounds. Constant for
   * the whole round unless the Master changes it — settlement reads this, so it
   * must never move on its own.
   */
  getUsdInrRate(): number | null {
    return this.activeIndex === null ? null : this.rounds[this.activeIndex].usdInrRate
  }

  /** The active round's mode, or null between rounds. */
  getMode(): RoundMode | null {
    return this.activeIndex === null ? null : this.rounds[this.activeIndex].mode
  }

  /** The full ordered schedule (snapshots) with live statuses, for admin views. */
  getSchedule(): Round[] {
    return this.rounds.map(snapshot)
  }

  /**
   * Master-Terminal control: set commission on the ACTIVE round, or — when no
   * round is active — the NEXT pending round. Returns a snapshot of the round
   * changed, or null if there is neither an active nor a pending round.
   */
  setCommission(enabled: boolean): Round | null {
    const target =
      this.activeIndex !== null
        ? this.rounds[this.activeIndex]
        : this.rounds.find((r) => r.status === 'pending')
    if (!target) return null
    target.commissionEnabled = enabled
    return snapshot(target)
  }

  /**
   * Master-Terminal control: set the USD→INR rate on the ACTIVE round, or — when
   * no round is active — the NEXT pending round. Same targeting rule as
   * setCommission. Returns a snapshot of the round changed, or null if there is
   * neither an active nor a pending round.
   *
   * This is the ONLY way the rate ever moves. Changing it mid-round applies to
   * every subsequent fill in that round; fills already settled keep the rate
   * they were settled at, because their basis was fixed at the time.
   */
  setUsdInrRate(rate: number): Round | null {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`usdInrRate must be a positive number (got ${rate})`)
    }
    const target =
      this.activeIndex !== null
        ? this.rounds[this.activeIndex]
        : this.rounds.find((r) => r.status === 'pending')
    if (!target) return null
    target.usdInrRate = rate
    return snapshot(target)
  }
}

function snapshot(round: Round): Round {
  return { ...round }
}

// ---------------------------------------------------------------------------
// Convenience builder for the standard event shape
// ---------------------------------------------------------------------------

/** Per-round config for a "real" (scored) round. */
export interface RealRoundSpec {
  mode: RoundMode
  commissionEnabled: boolean
  /** Override the default real-round duration (seconds). */
  durationSeconds?: number
  /** Override the event's default USD→INR rate for this round. */
  usdInrRate?: number
}

export interface EventConfigOptions {
  /** Number of leading mock/practice rounds. Default 2. */
  mockRounds?: number
  /** Mock round duration in seconds. Default 300 (5 min). */
  mockDurationSeconds?: number
  /** Default real round duration in seconds. Default 600 (10 min). */
  realDurationSeconds?: number
  /** Mode used for mock rounds (informational; doesn't matter for mock). */
  mockMode?: RoundMode
  /** Whether commission is on during mock rounds. Default false. */
  mockCommission?: boolean
  /** USD→INR rate every round starts pinned at. Default DEFAULT_USD_INR_RATE. */
  usdInrRate?: number
}

/**
 * Build a standard event schedule: a run of mock rounds (5 min, no commission
 * by default) followed by the given real rounds (10 min each unless overridden),
 * each with its own mode and commission per the Master Terminal's schedule.
 *
 * Every round starts pinned at `options.usdInrRate` (or the default), which a
 * per-round `usdInrRate` on a RealRoundSpec can override. The Master can change
 * any round's rate later via RoundController.setUsdInrRate.
 */
export function createEventConfig(
  realRounds: readonly RealRoundSpec[],
  options: EventConfigOptions = {},
): EventConfig {
  const {
    mockRounds = 2,
    mockDurationSeconds = 300,
    realDurationSeconds = 600,
    mockMode = 'data_and_news',
    mockCommission = false,
    usdInrRate = DEFAULT_USD_INR_RATE,
  } = options

  const config: RoundDefinition[] = []
  for (let i = 0; i < mockRounds; i++) {
    config.push({
      id: `mock-${i + 1}`,
      mode: mockMode,
      durationSeconds: mockDurationSeconds,
      commissionEnabled: mockCommission,
      usdInrRate,
    })
  }
  realRounds.forEach((spec, i) => {
    config.push({
      id: `real-${i + 1}`,
      mode: spec.mode,
      durationSeconds: spec.durationSeconds ?? realDurationSeconds,
      commissionEnabled: spec.commissionEnabled,
      usdInrRate: spec.usdInrRate ?? usdInrRate,
    })
  })
  return config
}
