import { describe, expect, it } from 'vitest'
import { chartAction, type ChartSyncInput } from './chartSync'

const base: ChartSyncInput = {
  snapTicker: 'AAPL',
  ticker: 'AAPL',
  shape: 'AAPL|60',
  prevShape: 'AAPL|60',
  candleCount: 5,
  prevCount: 5,
  newestTime: 1000,
  lastPushedTime: 1000,
}
const at = (over: Partial<ChartSyncInput> = {}) => chartAction({ ...base, ...over })

// ---------------------------------------------------------------------------

describe('the crash: update() must never go backwards in time', () => {
  it('an older newest candle forces a full redraw instead of update()', () => {
    // The exact condition lightweight-charts throws on.
    expect(at({ newestTime: 940, lastPushedTime: 1000 })).toBe('setData')
  })

  it('even when the counts look perfectly incremental', () => {
    // Same count AND one-more both used to mean "safe to update".
    expect(at({ candleCount: 5, prevCount: 5, newestTime: 500, lastPushedTime: 1000 })).toBe('setData')
    expect(at({ candleCount: 6, prevCount: 5, newestTime: 500, lastPushedTime: 1000 })).toBe('setData')
  })

  it('one second backwards is still backwards', () => {
    expect(at({ newestTime: 999, lastPushedTime: 1000 })).toBe('setData')
  })

  it('the same time is NOT backwards — amending the current bucket is the norm', () => {
    expect(at({ newestTime: 1000, lastPushedTime: 1000 })).toBe('update')
  })

  it('forward is still an update', () => {
    expect(at({ newestTime: 1060, prevCount: 5, candleCount: 6, lastPushedTime: 1000 })).toBe('update')
  })

  it('nothing pushed yet cannot be gone backwards from', () => {
    expect(at({ lastPushedTime: null, newestTime: 500 })).toBe('update')
  })
})

describe('a snapshot for another instrument is ignored', () => {
  it('skips while the poll still holds the previous instrument', () => {
    // Click AAPL: `ticker` flips immediately, `snap` lags one poll.
    expect(at({ ticker: 'AAPL', snapTicker: 'NVDA', shape: 'AAPL|60', prevShape: 'NVDA|60' })).toBe('skip')
  })

  it('skips rather than drawing the wrong candles, whatever the counts', () => {
    expect(at({ snapTicker: 'KO', candleCount: 12, prevCount: 3 })).toBe('skip')
  })

  it('renders once the matching snapshot arrives', () => {
    expect(at({ ticker: 'AAPL', snapTicker: 'AAPL', shape: 'AAPL|60', prevShape: 'NVDA|60' })).toBe('setData')
  })

  it('a payload with no ticker field still renders — older servers keep working', () => {
    expect(at({ snapTicker: null })).toBe('update')
  })
})

describe('ordinary rendering is unchanged', () => {
  it('a new instrument redraws', () => {
    expect(at({ shape: 'NVDA|60', prevShape: 'AAPL|60', snapTicker: 'NVDA', ticker: 'NVDA' })).toBe('setData')
  })

  it('a new timeframe redraws', () => {
    expect(at({ shape: 'AAPL|300', prevShape: 'AAPL|60' })).toBe('setData')
  })

  it('an intra-bucket poll amends the newest bar', () => {
    expect(at({ candleCount: 5, prevCount: 5 })).toBe('update')
  })

  it('exactly one new bucket amends rather than refitting the view', () => {
    expect(at({ candleCount: 6, prevCount: 5, newestTime: 1060 })).toBe('update')
  })

  it('a jump of more than one bucket redraws', () => {
    expect(at({ candleCount: 9, prevCount: 5, newestTime: 1300 })).toBe('setData')
  })

  it('a shrinking window redraws', () => {
    expect(at({ candleCount: 4, prevCount: 5 })).toBe('setData')
  })

  it('empty data clears the series rather than updating nothing', () => {
    expect(at({ candleCount: 0, newestTime: null })).toBe('setData')
  })
})

describe('clicking through EVERY instrument, in every order', () => {
  /**
   * Real shape of the data: each instrument has its own newest trade time, and
   * counts that coincide often. Replay every ordered pair of clicks and assert
   * no sequence can produce an update() that moves time backwards — the
   * condition that crashes the chart.
   */
  const INSTRUMENTS = [
    { ticker: 'TSLA', count: 12, newest: 1_000_000 },
    { ticker: 'GLD', count: 11, newest: 999_988 },
    { ticker: 'QQQ', count: 9, newest: 999_991 },
    { ticker: 'SPY', count: 9, newest: 999_991 },
    { ticker: 'XOM', count: 9, newest: 999_991 },
    { ticker: 'JPM', count: 8, newest: 999_988 },
    { ticker: 'KO', count: 8, newest: 1_000_092 },
    { ticker: 'MCD', count: 7, newest: 999_987 },
    { ticker: 'NVDA', count: 6, newest: 999_989 },
    { ticker: 'AAPL', count: 3, newest: 1_000_090 },
  ]

  /** One click: the stale-snapshot render, then the matching one. */
  function click(
    from: (typeof INSTRUMENTS)[number],
    to: (typeof INSTRUMENTS)[number],
    state: { shape: string; count: number; pushed: number | null },
  ): ChartSyncInput[] {
    const seen: ChartSyncInput[] = []
    // Render 1 — ticker has flipped, snapshot has not.
    const stale: ChartSyncInput = {
      snapTicker: from.ticker, ticker: to.ticker,
      shape: `${to.ticker}|60`, prevShape: state.shape,
      candleCount: from.count, prevCount: state.count,
      newestTime: from.newest, lastPushedTime: state.pushed,
    }
    seen.push(stale)
    if (chartAction(stale) !== 'skip') {
      state.shape = stale.shape
      state.count = stale.candleCount
      state.pushed = stale.newestTime
    }
    // Render 2 — the matching snapshot arrives.
    const fresh: ChartSyncInput = {
      snapTicker: to.ticker, ticker: to.ticker,
      shape: `${to.ticker}|60`, prevShape: state.shape,
      candleCount: to.count, prevCount: state.count,
      newestTime: to.newest, lastPushedTime: state.pushed,
    }
    seen.push(fresh)
    const act = chartAction(fresh)
    if (act !== 'skip') {
      state.shape = fresh.shape
      state.count = fresh.candleCount
      state.pushed = act === 'setData' ? fresh.newestTime : Math.max(fresh.newestTime!, state.pushed ?? -Infinity)
    }
    return seen
  }

  it('no click sequence ever produces a backwards update()', () => {
    for (const from of INSTRUMENTS) {
      for (const to of INSTRUMENTS) {
        const state = { shape: `${from.ticker}|60`, count: from.count, pushed: from.newest }
        for (const input of click(from, to, state)) {
          const act = chartAction(input)
          if (act === 'update') {
            // The invariant lightweight-charts enforces.
            expect(input.newestTime).not.toBeNull()
            expect(input.newestTime!).toBeGreaterThanOrEqual(input.lastPushedTime ?? -Infinity)
          }
        }
      }
    }
  })

  it('the stale render is always skipped, so no wrong candles are ever drawn', () => {
    for (const from of INSTRUMENTS) {
      for (const to of INSTRUMENTS) {
        if (from.ticker === to.ticker) continue
        const state = { shape: `${from.ticker}|60`, count: from.count, pushed: from.newest }
        const [stale] = click(from, to, state)
        expect(chartAction(stale)).toBe('skip')
      }
    }
  })

  it('AAPL after KO — the pair that crashed, since AAPL is 2s older', () => {
    const ko = INSTRUMENTS.find((i) => i.ticker === 'KO')!
    const aapl = INSTRUMENTS.find((i) => i.ticker === 'AAPL')!
    expect(aapl.newest).toBeLessThan(ko.newest) // AAPL genuinely lags

    const state = { shape: 'KO|60', count: ko.count, pushed: ko.newest }
    for (const input of click(ko, aapl, state)) {
      const act = chartAction(input)
      if (act === 'update') expect(input.newestTime!).toBeGreaterThanOrEqual(input.lastPushedTime!)
    }
    expect(state.shape).toBe('AAPL|60') // it did render, it just did not crash
    expect(state.pushed).toBe(aapl.newest)
  })
})
