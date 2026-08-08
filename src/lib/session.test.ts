import { beforeEach, describe, expect, it } from 'vitest'
import {
  accessToken,
  clear,
  get,
  isAuthenticated,
  isExpired,
  refreshToken,
  resetCacheForTests,
  save,
  saveTokens,
  type Session,
} from './session'

const KEY = 'mochatrade.session'

const s = (over: Partial<Session> = {}): Session => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3_600_000,
  accountId: 'acct-1',
  role: 'team',
  username: 'team01',
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  resetCacheForTests()
})

// ---------------------------------------------------------------------------

describe('storing and reading a session', () => {
  it('round-trips everything login returns', () => {
    save(s())
    const got = get()!
    expect(got.accessToken).toBe('access-1')
    expect(got.refreshToken).toBe('refresh-1')
    expect(got.accountId).toBe('acct-1')
    expect(got.role).toBe('team')
    expect(got.username).toBe('team01')
  })

  it('survives a page reload — it is in localStorage, not memory', () => {
    save(s())
    resetCacheForTests() // simulate a fresh page load
    expect(get()!.accessToken).toBe('access-1')
    expect(isAuthenticated()).toBe(true)
  })

  it('reports no session before login', () => {
    expect(get()).toBeNull()
    expect(accessToken()).toBeNull()
    expect(refreshToken()).toBeNull()
    expect(isAuthenticated()).toBe(false)
  })

  it('clear() removes it from storage, not just memory', () => {
    save(s())
    clear()
    expect(localStorage.getItem(KEY)).toBeNull()
    resetCacheForTests()
    expect(isAuthenticated()).toBe(false)
  })
})

describe('REFRESH TOKEN ROTATION — the sharpest edge', () => {
  it('saveTokens replaces the spent refresh token with the new one', () => {
    save(s({ accessToken: 'access-1', refreshToken: 'refresh-1' }))
    saveTokens({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: Date.now() + 3_600_000 })

    expect(accessToken()).toBe('access-2')
    expect(refreshToken()).toBe('refresh-2') // NOT refresh-1
  })

  it('two refreshes in a row each advance the token — never reuses the spent one', () => {
    save(s({ accessToken: 'a1', refreshToken: 'r1' }))

    saveTokens({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 })
    expect(refreshToken()).toBe('r2')

    saveTokens({ accessToken: 'a3', refreshToken: 'r3', expiresAt: Date.now() + 3_600_000 })
    expect(refreshToken()).toBe('r3')
    expect(accessToken()).toBe('a3')
  })

  it('the rotated token is PERSISTED, so a reload does not resurrect the old one', () => {
    save(s({ refreshToken: 'r1' }))
    saveTokens({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 })
    resetCacheForTests() // fresh page load
    expect(refreshToken()).toBe('r2')
  })

  it('keeps identity across a refresh — only the tokens move', () => {
    save(s({ accountId: 'acct-9', role: 'master', username: 'master' }))
    saveTokens({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 1000 })
    const got = get()!
    expect(got.accountId).toBe('acct-9')
    expect(got.role).toBe('master')
    expect(got.username).toBe('master')
  })

  it('refreshing with no session stored is a no-op, not a partial write', () => {
    saveTokens({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() })
    expect(get()).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})

describe('expiry', () => {
  it('a fresh token is not expired', () => {
    save(s({ expiresAt: Date.now() + 3_600_000 }))
    expect(isExpired()).toBe(false)
  })

  it('a past expiry is expired', () => {
    save(s({ expiresAt: Date.now() - 1000 }))
    expect(isExpired()).toBe(true)
  })

  it('expires EARLY by a minute, to absorb clock skew', () => {
    const now = Date.now()
    save(s({ expiresAt: now + 30_000 })) // 30s left, inside the 60s skew
    expect(isExpired(now)).toBe(true)
    save(s({ expiresAt: now + 90_000 })) // 90s left, outside it
    expect(isExpired(now)).toBe(false)
  })

  it('no session counts as expired', () => {
    expect(isExpired()).toBe(true)
  })

  it('an unknown expiry defers to the server rather than forcing a refresh loop', () => {
    save(s({ expiresAt: 0 }))
    expect(isExpired()).toBe(false)
  })
})

describe('corrupt or partial storage never strands the user', () => {
  it('unparseable JSON reads as no session', () => {
    localStorage.setItem(KEY, '{not json')
    resetCacheForTests()
    expect(get()).toBeNull()
  })

  it('a session missing its access token is discarded', () => {
    localStorage.setItem(KEY, JSON.stringify({ refreshToken: 'r1' }))
    resetCacheForTests()
    expect(get()).toBeNull()
  })

  it('a session missing its refresh token is discarded', () => {
    localStorage.setItem(KEY, JSON.stringify({ accessToken: 'a1' }))
    resetCacheForTests()
    expect(get()).toBeNull()
  })

  it('missing identity fields degrade to empty strings, not a crash', () => {
    localStorage.setItem(KEY, JSON.stringify({ accessToken: 'a1', refreshToken: 'r1' }))
    resetCacheForTests()
    const got = get()!
    expect(got.accessToken).toBe('a1')
    expect(got.role).toBe('')
    expect(got.expiresAt).toBe(0)
  })
})

describe('no Supabase anything', () => {
  it('stores under our own key, not a Supabase one', () => {
    save(s())
    const keys = Object.keys(localStorage)
    expect(keys).toContain(KEY)
    expect(keys.some((k) => k.startsWith('sb-'))).toBe(false)
  })

  it('the stored blob contains no supabase URL or key material', () => {
    save(s())
    const raw = localStorage.getItem(KEY)!
    expect(raw).not.toMatch(/supabase\.co/)
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./) // no JWT beyond our own opaque tokens
  })
})
