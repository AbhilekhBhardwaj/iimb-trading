/**
 * HTTP API server — the single authoritative process that hosts the engine.
 *
 * The browser terminal cannot touch TradingService directly (it holds in-memory
 * order books and uses the service-role key), so this Node process owns one
 * TradingService + RoundController and exposes JSON endpoints the terminal polls.
 *
 * Auth: every request (except /api/health) carries the user's Supabase access
 * token as `Authorization: Bearer <jwt>`. We verify it with the anon client and
 * read the caller's role from profiles; writes then go through the service-role
 * TradingService. The service-role key never leaves this process.
 *
 * Run: npx tsx server/api.ts   (or `npm run api`)
 */

import { createEventConfig, RoundController, type Side } from '@iimb-trading/engine'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
// NOTE: server/rate.ts's startRateDrift() is deliberately NOT called. Under INR
// cash settlement a rate move realizes real P&L on every close, so the rate is
// pinned per round and only the Master changes it (POST /api/round/rate).
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'
import { usernameToEmail } from '../src/lib/accounts'
import { JSON_HEADERS } from './httpHeaders'

// API_PORT wins in local dev (Vite proxies /api → 8787); on Railway/PaaS the
// platform injects PORT and there is no API_PORT, so we bind that instead.
const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 8787)

// createAdminClient() loads .env; do it first so the anon vars are available.
const admin = createAdminClient()
const SUPABASE_URL = process.env.SUPABASE_URL!
const ANON_KEY = process.env.SUPABASE_ANON_KEY
if (!ANON_KEY) {
  console.error('✖ Missing SUPABASE_ANON_KEY in .env (needed to verify user tokens)')
  process.exit(1)
}
const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

// Default event schedule: 1 mock round, then 3 scored rounds. The Master
// Terminal starts/ends them; teams trade only while one is active.
const rounds = new RoundController(
  createEventConfig(
    [
      { mode: 'data_and_news', commissionEnabled: false },
      { mode: 'only_data', commissionEnabled: true },
      { mode: 'silent', commissionEnabled: true },
    ],
    { mockRounds: 1, mockDurationSeconds: 300, realDurationSeconds: 600 },
  ),
)
const service = new TradingService(admin as SupabaseClient, rounds)

// ---------------------------------------------------------------------------
// Auth (token → { accountId, role, username }), cached briefly.
// ---------------------------------------------------------------------------
interface Caller {
  accountId: string
  role: string
  username: string
}
const callerCache = new Map<string, { caller: Caller; at: number }>()
const CALLER_TTL_MS = 60_000

async function authenticate(req: IncomingMessage): Promise<Caller | null> {
  const header = req.headers['authorization']
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null

  const cached = callerCache.get(token)
  if (cached && Date.now() - cached.at < CALLER_TTL_MS) return cached.caller

  const { data, error } = await anon.auth.getUser(token)
  if (error || !data.user) return null
  const { data: profile } = await admin
    .from('profiles')
    .select('role, username')
    .eq('id', data.user.id)
    .single()
  if (!profile) return null
  const caller: Caller = { accountId: data.user.id, role: profile.role as string, username: profile.username as string }
  callerCache.set(token, { caller, at: Date.now() })
  return caller
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const nowSec = () => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Static SPA serving (production single-service deploy).
//
// In local dev the Vite dev server serves the app and proxies /api here, so
// none of this runs. In production (e.g. Railway) this same process serves the
// built `dist/` for every non-/api route AND handles /api on ONE port — keeping
// the frontend same-origin with the API (no CORS, no second service) and, more
// importantly, guaranteeing the authoritative in-memory TradingService is a
// single instance. Do NOT scale this service to >1 replica.
// ---------------------------------------------------------------------------
const DIST_DIR = resolve(process.cwd(), 'dist')
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function sendFile(res: ServerResponse, filePath: string, status = 200): void {
  res.writeHead(status, { 'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(res)
}

function serveStatic(res: ServerResponse, path: string): void {
  if (!existsSync(DIST_DIR)) return json(res, 503, { error: 'frontend not built (run npm run build)' })
  // Resolve inside dist and reject path traversal.
  const rel = normalize(decodeURIComponent(path)).replace(/^([/\\]|\.\.[/\\])+/, '')
  const candidate = join(DIST_DIR, rel)
  if (!candidate.startsWith(DIST_DIR)) return json(res, 403, { error: 'forbidden' })
  if (path !== '/' && existsSync(candidate) && statSync(candidate).isFile()) return sendFile(res, candidate)
  // SPA fallback: client-side routes (/terminal, /portfolio, …) resolve to index.html.
  const index = join(DIST_DIR, 'index.html')
  if (existsSync(index)) return sendFile(res, index)
  return json(res, 404, { error: 'not found' })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'OPTIONS') return json(res, 204, {})

  // Everything outside /api is the built SPA (production single-service deploy).
  if (!path.startsWith('/api')) return serveStatic(res, path)

  if (path === '/api/health') return json(res, 200, { ok: true })

  // Catch-all: any uncaught error from auth or the trading service is recorded
  // to event_log (event_type 'error') BEFORE it becomes a 500, with whatever
  // request/account context is available.
  let callerCtx: Caller | null = null
  try {
    // Self-healing round timer: every request re-checks whether the active
    // round's duration has elapsed and closes it if so, so the round ends on
    // schedule even if the Master never clicks "end". No-op when nothing is due.
    await service.maybeAutoEndRound()

    // -- AUTH: the only routes reachable WITHOUT a token ---------------------
    // The browser no longer holds a Supabase key, so sign-in, refresh and
    // sign-out all happen here. Credentials are exchanged for tokens by the
    // server; nothing about Supabase is visible to the client.
    //
    // Never log a request body on these routes: it contains a plaintext
    // password.
    if (method === 'POST' && path === '/api/auth/login') {
      const b = await readJson(req)
      const username = String(b.username ?? '').trim()
      const password = String(b.password ?? '')
      if (!username || !password) return json(res, 400, { error: 'username and password are required' })

      const { data, error } = await anon.auth.signInWithPassword({
        email: usernameToEmail(username),
        password,
      })
      // Deliberately one generic message for both a bad username and a bad
      // password, so this cannot be used to enumerate accounts.
      if (error || !data.user || !data.session) return json(res, 401, { error: 'invalid credentials' })

      // The role read that used to happen in the browser against profiles.
      const { data: profile } = await admin
        .from('profiles')
        .select('role, username')
        .eq('id', data.user.id)
        .single()
      // Authenticated but no profile row: refuse rather than leaving a
      // half-signed-in session, exactly as the old client-side flow did.
      if (!profile) return json(res, 401, { error: 'invalid credentials' })

      return json(res, 200, {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ? data.session.expires_at * 1000 : Date.now() + 3_600_000,
        accountId: data.user.id,
        role: profile.role as string,
        username: profile.username as string,
      })
    }

    if (method === 'POST' && path === '/api/auth/refresh') {
      const b = await readJson(req)
      const refreshToken = String(b.refreshToken ?? '')
      if (!refreshToken) return json(res, 400, { error: 'refreshToken is required' })

      const { data, error } = await anon.auth.refreshSession({ refresh_token: refreshToken })
      if (error || !data.session) return json(res, 401, { error: 'invalid refresh token' })

      // Supabase ROTATES the refresh token: the one returned here replaces the
      // one just spent. Returning it is not optional — a client that keeps
      // re-sending the old token is logged out on its second refresh.
      return json(res, 200, {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt: data.session.expires_at ? data.session.expires_at * 1000 : Date.now() + 3_600_000,
      })
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      // Best-effort revocation. The client clears its own storage regardless,
      // so a failure here must never leave someone unable to sign out.
      const header = req.headers['authorization']
      const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null
      if (token) {
        callerCache.delete(token)
        try {
          await admin.auth.admin.signOut(token)
        } catch {
          /* already expired or revoked — signing out is still a success */
        }
      }
      return json(res, 200, { ok: true })
    }

    const caller = await authenticate(req)
    if (!caller) return json(res, 401, { error: 'unauthorized' })
    callerCtx = caller
    const requireMaster = () => caller.role === 'master'

  // -- reads ---------------------------------------------------------------
  if (method === 'GET' && path === '/api/bootstrap') {
    return json(res, 200, {
      accountId: caller.accountId,
      role: caller.role,
      username: caller.username,
      instruments: service.instrumentCatalogue(),
      round: service.getRoundStatus(),
      rate: service.rateInr(),
      serverTime: Date.now(),
    })
  }

  if (method === 'GET' && path === '/api/portfolio') {
    return json(res, 200, await service.portfolio(caller.accountId))
  }

  // Leaderboard: open to every authenticated caller (teams, master, market maker).
  if (method === 'GET' && path === '/api/leaderboard') {
    return json(res, 200, { leaderboard: await service.leaderboard() })
  }

  if (method === 'GET' && path === '/api/round/schedule') {
    return json(res, 200, { schedule: service.getSchedule() })
  }

  if (method === 'GET' && path === '/api/notifications') {
    return json(res, 200, { notifications: await service.notifications(50) })
  }

  if (method === 'GET' && path === '/api/snapshot') {
    const ticker = url.searchParams.get('ticker')
    const windowSec = Number(url.searchParams.get('priceWindowSec') ?? 600)
    return json(res, 200, await service.snapshot(caller.accountId, caller.role, ticker, windowSec))
  }

  // -- order flow ----------------------------------------------------------
  if (method === 'POST' && path === '/api/orders') {
    const b = await readJson(req)
    const ticker = String(b.ticker ?? '')
    const type = b.type === 'market' ? 'market' : 'limit'
    const result = await service.placeOrder({
      accountId: caller.accountId,
      ticker,
      // Passed through UNCOERCED. Defaulting anything-not-'sell' to 'buy' meant
      // a typo executed as a real buy; placeOrder rejects anything that is not
      // exactly 'buy' or 'sell'.
      side: b.side as Side,
      type,
      price: b.price === undefined || b.price === null ? undefined : Number(b.price),
      qty: Number(b.qty),
      leverage: b.leverage === undefined ? 1 : Number(b.leverage),
      markPrice: type === 'market' ? service.ltp(ticker) : undefined,
      // Drives the market maker's buying-power exemption. Taken from the verified
      // token, never from the request body.
      role: caller.role,
    })
    return json(res, 200, result)
  }

  if (method === 'POST' && path === '/api/orders/cancel') {
    const b = await readJson(req)
    const cancelled = await service.cancelOrder(String(b.orderId ?? ''), {
      accountId: caller.accountId,
      role: caller.role,
    })
    return json(res, 200, { cancelled })
  }

  // -- market-maker-only: liquidation ---------------------------------------
  // Detection is continuous, enforcement is manual. The market maker sees who
  // is past their threshold and decides, position by position, whether to close.
  const requireMarketMaker = () => caller.role === 'market_maker'

  if (method === 'GET' && path === '/api/liquidations') {
    if (!requireMarketMaker()) return json(res, 403, { error: 'forbidden' })
    return json(res, 200, {
      positions: await service.liquidatablePositions({ accountId: caller.accountId, role: caller.role }),
    })
  }

  if (method === 'POST' && path === '/api/liquidations/close') {
    if (!requireMarketMaker()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    const result = await service.liquidatePosition(
      { accountId: caller.accountId, role: caller.role },
      String(b.accountId ?? ''),
      String(b.ticker ?? ''),
    )
    if (!result.applied) return json(res, 400, { error: result.reason, applied: false })
    return json(res, 200, { applied: true, event: result.event })
  }

  // -- master-only (Master Terminal wires the UI for these next) -----------
  if (method === 'POST' && path === '/api/round/start') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const round = await service.startRound(nowSec())
    return json(res, 200, { round: service.getRoundStatus(), id: round.id })
  }
  if (method === 'POST' && path === '/api/round/end') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    await service.endRound(nowSec())
    return json(res, 200, { round: service.getRoundStatus() })
  }
  if (method === 'POST' && path === '/api/round/commission') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    const changed = await service.setCommission(b.enabled === true)
    return json(res, 200, { round: service.getRoundStatus(), changed })
  }
  // The USD→INR rate is set by hand and pinned for the round — it never drifts on
  // its own. The Master may change it at any time, including mid-round: the change
  // applies to subsequent fills only, and already-settled trades keep their rate.
  if (method === 'POST' && path === '/api/round/rate') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    const rate = Number(b.usdInrRate ?? b.rate)
    if (!Number.isFinite(rate) || rate <= 0) {
      return json(res, 400, { error: 'usdInrRate must be a positive number' })
    }
    const result = await service.setUsdInrRate({ accountId: caller.accountId, role: caller.role }, rate)
    if (!result.applied) return json(res, 400, { error: result.reason, applied: false })
    return json(res, 200, { round: service.getRoundStatus(), changed: result.changed })
  }
  // Instrument starting prices. Usable before every round, not just the first —
  // see TradingService.setInstrumentPrices for why it writes both the reference
  // price and the in-memory last price.
  if (method === 'POST' && path === '/api/instruments/price') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    // Accept either a batch ({ prices: [...] }) or a single { ticker, price }.
    const raw = Array.isArray(b.prices) ? b.prices : b.ticker !== undefined ? [b] : []
    const updates = (raw as Record<string, unknown>[]).map((u) => ({
      ticker: String(u.ticker ?? ''),
      price: Number(u.price),
    }))
    const result = await service.setInstrumentPrices(
      { accountId: caller.accountId, role: caller.role },
      updates,
    )
    if (!result.applied) return json(res, 400, { error: result.reason, applied: false })
    return json(res, 200, { applied: true, changes: result.changes, instruments: service.instrumentCatalogue() })
  }
  // Commission RATE (distinct from the on/off toggle above). Changeable at any
  // time, including mid-round: forward-only, and each fill records the rate it
  // was charged at.
  if (method === 'POST' && path === '/api/round/commission-rate') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    const rate = Number(b.commissionRate ?? b.rate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      return json(res, 400, { error: 'commissionRate must be a fraction between 0 and 1' })
    }
    const result = await service.setCommissionRate({ accountId: caller.accountId, role: caller.role }, rate)
    if (!result.applied) return json(res, 400, { error: result.reason, applied: false })
    return json(res, 200, { round: service.getRoundStatus(), changed: result.changed })
  }
  // Slippage nudge visibility. Display-only, so no settlement concerns — the
  // Master may flip it at any time, including mid-round.
  if (method === 'POST' && path === '/api/round/slippage') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    const result = await service.setSlippageEnabled(
      { accountId: caller.accountId, role: caller.role },
      b.enabled === true,
    )
    if (!result.applied) return json(res, 400, { error: result.reason, applied: false })
    return json(res, 200, { round: service.getRoundStatus(), changed: result.changed })
  }
  // DESTRUCTIVE: wipes all trading state. Requires an explicit typed confirmation
  // in the body as a second gate beyond master auth, so a stray POST cannot do it.
  if (method === 'POST' && path === '/api/admin/reset') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    if (String(b.confirm ?? '') !== 'RESET') {
      return json(res, 400, { error: 'confirmation required: send { confirm: "RESET" }', applied: false })
    }
    const result = await service.resetEvent({ accountId: caller.accountId, role: caller.role })
    if (!result.applied) return json(res, 400, { error: result.reason, applied: false })
    return json(res, 200, { applied: true, cleared: result.cleared, round: service.getRoundStatus() })
  }
  if (method === 'GET' && path === '/api/admin/teams') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    return json(res, 200, { teams: await service.teamsOverview() })
  }
  if (method === 'POST' && path === '/api/notifications') {
    if (!requireMaster()) return json(res, 403, { error: 'forbidden' })
    const b = await readJson(req)
    const kind = ['announcement', 'daily_news', 'data'].includes(String(b.kind)) ? String(b.kind) : 'announcement'
    await service.publishNotification(kind, String(b.title ?? ''), b.body ? String(b.body) : undefined)
    return json(res, 200, { ok: true })
  }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? null) : null
    await service.logError(message, {
      path,
      method,
      accountId: callerCtx?.accountId ?? null,
      role: callerCtx?.role ?? null,
      stack,
    })
    throw err // rethrow so the outer createServer.catch returns the 500
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  await service.loadInstruments()
  const recovery = await service.rehydrate()
  console.log(
    `TradingService ready. Recovery: ${recovery.roundsRestored} round(s), ` +
      `${recovery.ordersRestored} order(s), ${recovery.accountsWithPnl} account(s) with P&L. ` +
      `USD/INR pinned at ${service.rateInr()}.`,
  )

  // Companion to the per-request auto-end check in handle(): with every client
  // disconnected there are no requests to piggyback on, and a round would stay
  // open indefinitely. unref'd so it never holds up process shutdown.
  const roundTimer = setInterval(() => {
    service.maybeAutoEndRound().catch((err) =>
      console.error('auto-end round failed:', err instanceof Error ? err.message : err),
    )
  }, 1000)
  ;(roundTimer as { unref?: () => void }).unref?.()

  createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('API error:', err instanceof Error ? err.message : err)
      if (!res.headersSent) json(res, 500, { error: 'internal error' })
    })
  }).listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`))
}

main().catch((err) => {
  console.error('✖ API failed to start:', err instanceof Error ? err.message : err)
  process.exit(1)
})
