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

import { createEventConfig, RoundController } from '@iimb-trading/engine'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { startRateDrift, usdInr } from './rate'
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'

// API_PORT wins in local dev (Vite proxies /api → 8787); on Railway/PaaS the
// platform injects PORT and there is no API_PORT, so we bind that instead.
const PORT = Number(process.env.API_PORT ?? process.env.PORT ?? 8787)

// createAdminClient() loads .env; do it first so the anon vars are available.
const admin = createAdminClient()
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY
if (!ANON_KEY) {
  console.error('✖ Missing VITE_SUPABASE_ANON_KEY / SUPABASE_ANON_KEY in .env (needed to verify user tokens)')
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
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
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
      rate: usdInr(),
      serverTime: Date.now(),
    })
  }

  if (method === 'GET' && path === '/api/portfolio') {
    return json(res, 200, await service.portfolio(caller.accountId))
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
      side: b.side === 'sell' ? 'sell' : 'buy',
      type,
      price: b.price === undefined || b.price === null ? undefined : Number(b.price),
      qty: Number(b.qty),
      leverage: b.leverage === undefined ? 1 : Number(b.leverage),
      markPrice: type === 'market' ? service.ltp(ticker) : undefined,
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
  startRateDrift() // live USD→INR rate (drift is API-server only; tests stay fixed)
  const recovery = await service.rehydrate()
  console.log(
    `TradingService ready. Recovery: ${recovery.roundsRestored} round(s), ` +
      `${recovery.ordersRestored} order(s), ${recovery.accountsWithPnl} account(s) with P&L.`,
  )

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
