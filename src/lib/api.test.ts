import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The frontend no longer talks to Supabase at all. api.ts reads the access
// token from ./session and refreshes by POSTing to /api/auth/refresh, so the
// refresh path now runs through the SAME fetch mock as everything else.
const { accessToken, refreshToken, saveTokens } = vi.hoisted(() => ({
  accessToken: vi.fn(),
  refreshToken: vi.fn(),
  saveTokens: vi.fn(),
}))
vi.mock('./session', () => ({ accessToken, refreshToken, saveTokens }))

/** A successful /api/auth/refresh response. */
const refreshOk = (n = 2) => ({
  ok: true,
  status: 200,
  json: async () => ({ accessToken: `access-${n}`, refreshToken: `refresh-${n}`, expiresAt: Date.now() + 3_600_000 }),
})
/** A rejected refresh (expired/invalid refresh token). */
const refreshDead = { ok: false, status: 401, json: async () => ({ error: 'invalid refresh token' }) }
/** Count only the refresh POSTs among all fetch calls. */
const refreshCalls = (m: ReturnType<typeof vi.fn>) =>
  m.mock.calls.filter((c) => String(c[0]).includes('/auth/refresh')).length

describe('api.ts — 401 / expired-session handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let replace: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules() // fresh module state each test (resets the one-shot redirect guard)
    accessToken.mockReset(); refreshToken.mockReset(); saveTokens.mockReset()
    accessToken.mockReturnValue('stale-token')
    refreshToken.mockReturnValue('refresh-1')
    fetchMock = vi.fn()
    replace = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('location', { replace }) // window.location.replace spy (jsdom: window === globalThis)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('normal 200: never touches auth', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ leaderboard: [] }) })
    const { api } = await import('./api')
    await expect(api.leaderboard()).resolves.toEqual({ leaderboard: [] })
    expect(refreshCalls(fetchMock)).toBe(0)
    expect(replace).not.toHaveBeenCalled()
  })

  it('GET 401 → refresh succeeds → retries and returns data, NO redirect', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 }) // expired token
      .mockResolvedValueOnce(refreshOk()) // POST /api/auth/refresh
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ leaderboard: [{ rank: 1 }] }) })

    const { api } = await import('./api')
    await expect(api.leaderboard()).resolves.toEqual({ leaderboard: [{ rank: 1 }] })
    expect(refreshCalls(fetchMock)).toBe(1)
    expect(saveTokens).toHaveBeenCalledTimes(1) // the ROTATED pair is persisted
    expect(fetchMock).toHaveBeenCalledTimes(3) // original + refresh + retry
    expect(replace).not.toHaveBeenCalled()
  })

  it('GET 401 → refresh FAILS → redirects to /login (does not hang)', async () => {
    fetchMock.mockResolvedValue(refreshDead) // every call, incl. the refresh, 401s

    const { api } = await import('./api')
    await expect(api.portfolio()).rejects.toThrow(/401/)
    expect(refreshCalls(fetchMock)).toBe(1)
    expect(saveTokens).not.toHaveBeenCalled() // nothing to persist on a failed refresh
    expect(replace).toHaveBeenCalledWith('/login')
  })

  it('GET 401 → refresh succeeds but retry STILL 401 → redirects to /login', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes('/auth/refresh') ? refreshOk() : { ok: false, status: 401 }),
    )

    const { api } = await import('./api')
    await expect(api.leaderboard()).rejects.toThrow(/401/)
    expect(refreshCalls(fetchMock)).toBe(1) // only one refresh attempt
    expect(replace).toHaveBeenCalledWith('/login')
  })

  it('POST 401 → refresh fails → redirects to /login (order not silently retried)', async () => {
    fetchMock.mockResolvedValue(refreshDead)

    const { api } = await import('./api')
    await expect(api.placeOrder({ ticker: 'AAPL', side: 'buy', type: 'market', qty: 1, leverage: 1 })).rejects.toThrow(/401/)
    expect(replace).toHaveBeenCalledWith('/login')
  })

  it('concurrent 401s share ONE refresh (de-duped)', async () => {
    // Every fetch 401s; refresh "succeeds" so each call retries once then redirects.
    // Delay the refresh so all three callers reach tryRefresh() while in-flight.
    fetchMock.mockImplementation((url: string) =>
      String(url).includes('/auth/refresh')
        ? new Promise((r) => setTimeout(() => r(refreshOk()), 20))
        : Promise.resolve({ ok: false, status: 401 }),
    )

    const { api } = await import('./api')
    await Promise.allSettled([api.leaderboard(), api.portfolio(), api.notificationsList()])
    // Three concurrent callers, but only one refresh network round-trip.
    expect(refreshCalls(fetchMock)).toBe(1) // three callers, ONE refresh
    expect(replace).toHaveBeenCalledWith('/login')
  })
})
