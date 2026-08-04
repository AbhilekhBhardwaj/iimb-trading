import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock ./supabase so importing api.ts doesn't construct a real client (which
// would need VITE_ env vars). We control refreshSession/getSession per test.
const { refreshSession, getSession } = vi.hoisted(() => ({ refreshSession: vi.fn(), getSession: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { refreshSession, getSession } } }))

describe('api.ts — 401 / expired-session handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let replace: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules() // fresh module state each test (resets the one-shot redirect guard)
    refreshSession.mockReset()
    getSession.mockReset()
    getSession.mockResolvedValue({ data: { session: { access_token: 'stale-token' } } })
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
    expect(refreshSession).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('GET 401 → refresh succeeds → retries and returns data, NO redirect', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 401 }) // expired token
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ leaderboard: [{ rank: 1 }] }) })
    refreshSession.mockResolvedValue({ data: { session: { access_token: 'fresh' } }, error: null })

    const { api } = await import('./api')
    await expect(api.leaderboard()).resolves.toEqual({ leaderboard: [{ rank: 1 }] })
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2) // original + one retry
    expect(replace).not.toHaveBeenCalled()
  })

  it('GET 401 → refresh FAILS → redirects to /login (does not hang)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 })
    refreshSession.mockResolvedValue({ data: { session: null }, error: { message: 'refresh token expired' } })

    const { api } = await import('./api')
    await expect(api.portfolio()).rejects.toThrow(/401/)
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/login')
  })

  it('GET 401 → refresh succeeds but retry STILL 401 → redirects to /login', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 }) // always 401
    refreshSession.mockResolvedValue({ data: { session: { access_token: 'fresh' } }, error: null })

    const { api } = await import('./api')
    await expect(api.leaderboard()).rejects.toThrow(/401/)
    expect(refreshSession).toHaveBeenCalledTimes(1) // only one refresh attempt
    expect(replace).toHaveBeenCalledWith('/login')
  })

  it('POST 401 → refresh fails → redirects to /login (order not silently retried)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 })
    refreshSession.mockResolvedValue({ data: { session: null }, error: { message: 'expired' } })

    const { api } = await import('./api')
    await expect(api.placeOrder({ ticker: 'AAPL', side: 'buy', type: 'market', qty: 1, leverage: 1 })).rejects.toThrow(/401/)
    expect(replace).toHaveBeenCalledWith('/login')
  })

  it('concurrent 401s share ONE refresh (de-duped)', async () => {
    // Every fetch 401s; refresh "succeeds" so each call retries once then redirects.
    fetchMock.mockResolvedValue({ ok: false, status: 401 })
    // Delay the refresh so all three callers reach tryRefresh() while it's in-flight.
    refreshSession.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ data: { session: { access_token: 'fresh' } }, error: null }), 20)),
    )

    const { api } = await import('./api')
    await Promise.allSettled([api.leaderboard(), api.portfolio(), api.notificationsList()])
    // Three concurrent callers, but only one refresh network round-trip.
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/login')
  })
})
