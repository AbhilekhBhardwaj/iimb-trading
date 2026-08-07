/**
 * Read-mostly checks against the LIVE deployed API. Verifies auth, the snapshot
 * contract and order gating on the real Railway process, without starting a
 * round (which would consume real-2 from the IIMB schedule).
 *
 * The only write is an order_rejected event_log row per rejected order, which
 * this script deletes again at the end.
 *
 * Run: npx tsx server/live-check.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { usernameToEmail } from '../src/lib/accounts'
import { createAdminClient } from './supabaseAdmin'

const BASE = 'https://iimb-tradingengine-production.up.railway.app'
const HERE = dirname(fileURLToPath(import.meta.url))

const admin = createAdminClient()
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!
const ANON = process.env.VITE_SUPABASE_ANON_KEY!

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

function credentials(): Map<string, string> {
  const csv = readFileSync(resolve(HERE, '..', 'scripts', 'output', 'credentials.csv'), 'utf8')
  const map = new Map<string, string>()
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [u, p] = line.split(',')
    if (u && p) map.set(u, p)
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
  console.log(`\nLive checks against ${BASE}\n`)
  const creds = credentials()
  const pw = (u: string) => creds.get(u) ?? ''

  console.log('1. Unauthenticated surface:')
  const health = (await (await fetch(`${BASE}/api/health`)).json()) as { ok?: boolean }
  check('health ok', health.ok === true)
  const unauth = (await (await fetch(`${BASE}/api/bootstrap`)).json()) as { error?: string }
  check('unauthenticated request rejected', unauth.error === 'unauthorized', unauth.error)

  console.log('\n2. Real logins against production auth:')
  const t3 = await login('team03', pw('team03'))
  const t4 = await login('team04', pw('team04'))
  check('team03 logged in', t3.length > 20)
  check('team04 logged in', t4.length > 20)

  console.log('\n3. Bootstrap + snapshot contract on the deployed build:')
  const boot = await api(t3, 'GET', '/api/bootstrap')
  check('role is team', boot.role === 'team', boot.role)
  check('10 instruments', boot.instruments?.length === 10, `${boot.instruments?.length}`)

  const snap = await api(t3, 'GET', '/api/snapshot?ticker=NVDA&priceWindowSec=300')
  check('snapshot has a pinned usd/inr rate', typeof snap.rate === 'number' && snap.rate > 0, `${snap.rate}`)
  check('round exposes commissionEnabled', typeof snap.round?.commissionEnabled === 'boolean', `${snap.round?.commissionEnabled}`)
  check('round exposes usdInrRate', typeof snap.round?.usdInrRate === 'number', `${snap.round?.usdInrRate}`)
  check('round is currently INACTIVE (no live event running)', snap.round?.active !== true, `active=${snap.round?.active}`)
  check('depth ladder present', snap.depth !== undefined)
  const nvda = snap.instruments?.find((i: any) => i.ticker === 'NVDA')
  check('instrument row carries ltp', typeof nvda?.ltp === 'number', `$${nvda?.ltp}`)

  console.log('\n4. Order gating (writes an order_rejected event we clean up):')
  const gated = await api(t3, 'POST', '/api/orders', { ticker: 'NVDA', side: 'buy', type: 'market', qty: 1, leverage: 1 })
  check('market order rejected with no active round', gated.accepted === false && gated.reason === 'no active round', gated.reason)

  console.log('\n5. Cleanup:')
  const { error } = await admin
    .from('event_log')
    .delete()
    .eq('event_type', 'order_rejected')
    .gte('created_at', new Date(Date.now() - 5 * 60_000).toISOString())
  check('order_rejected events from this run removed', !error, error?.message)

  console.log(`\n${failures === 0 ? '✅ ALL LIVE CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ live-check error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
