/**
 * The browser's session store, replacing Supabase's client-side auth entirely.
 *
 * The frontend no longer holds a Supabase URL or key. It exchanges credentials
 * for tokens at /api/auth/login and keeps them here; every API request reads
 * the access token from this module, and the 401 path refreshes through
 * /api/auth/refresh.
 *
 * Persistence is localStorage, which is where Supabase kept its session too —
 * so a page refresh or a reopened tab behaves exactly as before.
 *
 * REFRESH TOKEN ROTATION: Supabase issues a NEW refresh token every time one is
 * spent, and invalidates the old one. `save()` must therefore be called with
 * the whole new pair on every refresh. A client that re-sends the token it
 * already used is logged out on its second refresh — which is roughly an hour
 * in, i.e. mid-event. That is the single sharpest edge in this module.
 */

const STORAGE_KEY = 'mochatrade.session'

/** Refresh this far before the token actually expires, to absorb clock skew. */
const EXPIRY_SKEW_MS = 60_000

export interface Session {
  accessToken: string
  refreshToken: string
  /** Epoch ms at which the ACCESS token expires. */
  expiresAt: number
  accountId: string
  role: string
  username: string
}

/** The subset an auth response must carry to refresh a session. */
export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

let cached: Session | null | undefined

function read(): Session | null {
  if (cached !== undefined) return cached
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return (cached = null)
    const parsed = JSON.parse(raw) as Partial<Session>
    // A half-written or hand-edited entry is worse than none: treat anything
    // missing a token as no session at all rather than failing later mid-request.
    if (!parsed.accessToken || !parsed.refreshToken) return (cached = null)
    return (cached = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
      accountId: parsed.accountId ?? '',
      role: parsed.role ?? '',
      username: parsed.username ?? '',
    })
  } catch {
    return (cached = null)
  }
}

/** Persist a whole session (after login). */
export function save(s: Session): void {
  cached = s
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* private mode / quota — the in-memory copy still serves this tab */
  }
}

/**
 * Replace just the tokens, keeping identity. Called after every refresh, and
 * the reason rotation works: the NEW refresh token overwrites the spent one.
 */
export function saveTokens(t: TokenPair): void {
  const current = read()
  if (!current) return
  save({ ...current, ...t })
}

export function get(): Session | null {
  return read()
}

export function accessToken(): string | null {
  return read()?.accessToken ?? null
}

export function refreshToken(): string | null {
  return read()?.refreshToken ?? null
}

/** Is there a session at all? Route guards use this, not validity. */
export function isAuthenticated(): boolean {
  return read() !== null
}

/**
 * Has the access token expired (or is it about to)?
 *
 * Only advisory: the server is the authority, and a 401 triggers a refresh
 * regardless. This just lets a caller refresh proactively instead of taking a
 * guaranteed 401 first.
 */
export function isExpired(now = Date.now()): boolean {
  const s = read()
  if (!s) return true
  if (!s.expiresAt) return false // unknown expiry — let the server decide
  return now >= s.expiresAt - EXPIRY_SKEW_MS
}

export function clear(): void {
  cached = null
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing more we can do; the in-memory copy is already gone */
  }
}

/** Test seam: drop the in-memory copy so the next read hits storage. */
export function resetCacheForTests(): void {
  cached = undefined
}
