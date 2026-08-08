/**
 * End-to-end API smoke test: real Supabase logins → tokens → HTTP calls against
 * the running api.ts, exercising round control, order flow, role-based depth,
 * notifications, cancel ownership, and round gating. Requires `npm run api` to
 * be running. Run: npx tsx server/api-smoke.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { usernameToEmail } from '../src/lib/accounts'
import { createAdminClient } from './supabaseAdmin'

const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const HERE = dirname(fileURLToPath(import.meta.url))

createAdminClient() // side effect: loads .env
const SUPABASE_URL = process.env.SUPABASE_URL!
const ANON = process.env.SUPABASE_ANON_KEY!
const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

/** username -> password from the generated credentials CSV. */
function credentials(): Map<string, string> {
  const csv = readFileSync(resolve(HERE, '..', 'scripts', 'output', 'credentials.csv'), 'utf8')
  const map = new Map<string, string>()
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [username, password] = line.split(',')
    if (username && password) map.set(username, password)
  }
  return map
}

async function login(username: string, password: string): Promise<string> {
  const client = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email: usernameToEmail(username), password })
  if (error || !data.session) throw new Error(`login failed for ${username}: ${error?.message}`)
  return data.session.access_token
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

async function main(): Promise<void> {
  const creds = credentials()
  const pw = (u: string) => creds.get(u) ?? ''

  console.log('\nAPI smoke test against', BASE, '\n')

  // Health (no auth) + auth rejection.
  const health = (await (await fetch(`${BASE}/api/health`)).json()) as { ok?: boolean }
  check('health ok', health.ok === true)
  const unauth = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as { error?: string }
  check('unauthenticated request rejected', unauth.error === 'unauthorized')

  const master = await login('master', pw('master'))
  const t1 = await login('team01', pw('team01'))
  const t2 = await login('team02', pw('team02'))
  const mm = await login('marketmaker', pw('marketmaker'))

  // Bootstrap reflects role + instruments.
  const boot = await api(t1, 'GET', '/api/bootstrap')
  check('bootstrap: role team', boot.role === 'team', boot.role)
  check('bootstrap: 10 instruments', boot.instruments?.length === 10, `${boot.instruments?.length}`)

  // Gating: no active round yet → order rejected.
  const gated = await api(t1, 'POST', '/api/orders', { ticker: 'AAPL', side: 'buy', type: 'limit', price: 230, qty: 10, leverage: 2 })
  check('order rejected with no active round', gated.accepted === false && gated.reason === 'no active round', gated.reason)

  // Master starts a round + publishes an announcement.
  const started = await api(master, 'POST', '/api/round/start')
  check('master started a round', started.round?.active === true, JSON.stringify(started.round))
  check('non-master cannot start a round', (await api(t1, 'POST', '/api/round/start')).error === 'forbidden')
  await api(master, 'POST', '/api/notifications', { kind: 'announcement', title: 'Round 1 is live', body: 'Good luck.' })

  // team02 rests a sell; team01 buys into it → a trade.
  const sell = await api(t2, 'POST', '/api/orders', { ticker: 'AAPL', side: 'sell', type: 'limit', price: 230, qty: 20, leverage: 2 })
  check('team02 sell accepted', sell.accepted === true, sell.reason)
  const buy = await api(t1, 'POST', '/api/orders', { ticker: 'AAPL', side: 'buy', type: 'limit', price: 230, qty: 20, leverage: 2 })
  check('team01 buy accepted + matched', buy.accepted === true && buy.trades?.length === 1, JSON.stringify(buy.trades?.length))

  // team01 snapshot: LTP, position, tape, account margin, notifications.
  const snap = await api(t1, 'GET', '/api/snapshot?ticker=AAPL')
  const aapl = snap.instruments.find((i: any) => i.ticker === 'AAPL')
  check('snapshot: AAPL LTP = 230 (last trade)', aapl?.ltp === 230, `${aapl?.ltp}`)
  check('snapshot: team01 position long 20 @ 230', aapl?.position?.qty === 20 && aapl?.position?.avgPrice === 230, JSON.stringify(aapl?.position))
  check('snapshot: liquidation price present', typeof aapl?.position?.liquidationPrice === 'number', `${aapl?.position?.liquidationPrice}`)
  check('snapshot: times & sales has the trade w/ side', snap.trades?.length >= 1 && snap.trades[0].side === 'buy', JSON.stringify(snap.trades?.[0]))
  check('snapshot: account margin used > 0', snap.account?.marginUsedInr > 0, `₹${snap.account?.marginUsedInr}`)
  check('snapshot: announcement in notifications', snap.notifications?.some((n: any) => n.kind === 'announcement'), `${snap.notifications?.length}`)
  check('snapshot: price history non-empty', snap.prices?.length >= 1, `${snap.prices?.length}`)

  // Role-based depth: market maker sees individual resting orders; team does not.
  await api(mm, 'POST', '/api/orders', { ticker: 'AAPL', side: 'sell', type: 'limit', price: 240, qty: 15, leverage: 2 })
  const mmSnap = await api(mm, 'GET', '/api/snapshot?ticker=AAPL')
  const teamSnap = await api(t1, 'GET', '/api/snapshot?ticker=AAPL')
  check('depth: ask 15 @ 240 aggregated (zero levels hidden)', mmSnap.depth.asks.some((l: any) => l.price === 240 && l.qty === 15), JSON.stringify(mmSnap.depth.asks))
  check('market maker sees individual resting orders', Array.isArray(mmSnap.depth.restingOrders) && mmSnap.depth.restingOrders.length >= 1, `${mmSnap.depth.restingOrders?.length}`)
  check('team does NOT see individual resting orders', teamSnap.depth.restingOrders === undefined)

  // Cancel ownership: team01 rests an order; team02 can't cancel it, team01 can.
  const rest = await api(t1, 'POST', '/api/orders', { ticker: 'AAPL', side: 'buy', type: 'limit', price: 210, qty: 5, leverage: 2 })
  check("team02 cannot cancel team01's order", (await api(t2, 'POST', '/api/orders/cancel', { orderId: rest.orderId })).cancelled === false)
  check('team01 can cancel own order', (await api(t1, 'POST', '/api/orders/cancel', { orderId: rest.orderId })).cancelled === true)

  // Gating again after the round ends.
  await api(master, 'POST', '/api/round/end')
  const afterEnd = await api(t1, 'POST', '/api/orders', { ticker: 'AAPL', side: 'buy', type: 'limit', price: 230, qty: 5, leverage: 2 })
  check('order rejected after round ends', afterEnd.accepted === false && afterEnd.reason === 'no active round', afterEnd.reason)

  console.log(`\n${failures === 0 ? '✅ ALL API CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)

  // Cleanup: wipe everything this run wrote (server holds matching in-memory
  // state but we're about to stop it), restoring the pristine DB.
  await admin.from('trades').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await admin.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await admin.from('positions').delete().neq('account_id', '00000000-0000-0000-0000-000000000000')
  await admin.from('rounds').delete().neq('id', '')
  await admin.from('notifications').delete().neq('id', '00000000-0000-0000-0000-000000000000')
  await admin.from('event_log').delete().neq('event_type', 'account_provisioned')
  await admin.from('profiles').update({ realized_pnl: 0 }).neq('realized_pnl', 0)
  console.log('Cleaned up test artifacts.\n')

  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ API smoke error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
