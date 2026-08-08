/**
 * LIVE verification of the invalid-side fix, against the deployed app.
 *
 * Designed so a FAILURE is harmless. If the fix is not live, the old code
 * coerces the bad side into a BUY — so the order is sent as a LIMIT at $1, a
 * price nothing will ever sell into. It would rest rather than fill, and is
 * cancelled immediately below. Run as the master account, which is excluded
 * from the leaderboard, so nothing here can touch a competing team.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { usernameToEmail } from '../src/lib/accounts'

const API = 'https://iimb-tradingengine-production.up.railway.app'

/** Just enough of each response to reason about; the rest is printed raw. */
interface OrderResponse {
  accepted?: boolean
  reason?: string
  orderId?: string
  rejection?: { code?: string }
}
interface PortfolioResponse {
  workingOrders?: unknown[]
  openPositions?: number
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').map((l) => l.replace('\r', ''))
}

const env: Record<string, string> = {}
for (const line of lines('.env')) {
  const i = line.indexOf('=')
  if (i < 0 || line.trimStart().startsWith('#')) continue
  let v = line.slice(i + 1).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  env[line.slice(0, i).trim()] = v
}

const row = lines('scripts/output/credentials.csv').find((l) => l.startsWith('master,'))!.split(',')
const username = row[0].trim()
const password = row[1].trim()

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
const { data: auth, error } = await sb.auth.signInWithPassword({
  email: usernameToEmail(username),
  password,
})
if (error) throw new Error(`login failed: ${error.message}`)
const H = {
  authorization: `Bearer ${auth.session!.access_token}`,
  'content-type': 'application/json',
}

const before = (await (await fetch(`${API}/api/portfolio`, { headers: H })).json()) as PortfolioResponse
console.log(`account          ${username} (${auth.user!.id})`)
console.log(`working orders   ${before.workingOrders?.length ?? 0}`)
console.log(`open positions   ${before.openPositions}`)

// ---- THE TEST -------------------------------------------------------------
const body = { ticker: 'AAPL', side: 'hold', type: 'limit', price: 1, qty: 1, leverage: 1 }
console.log(`\nPOST /api/orders  ${JSON.stringify(body)}`)
const res = await fetch(`${API}/api/orders`, { method: 'POST', headers: H, body: JSON.stringify(body) })
const out = (await res.json()) as OrderResponse
console.log(`HTTP ${res.status}`)
console.log(JSON.stringify(out, null, 2))

// ---- Did anything actually happen? ----------------------------------------
const after = (await (await fetch(`${API}/api/portfolio`, { headers: H })).json()) as PortfolioResponse
console.log(`\nworking orders   ${before.workingOrders?.length ?? 0} -> ${after.workingOrders?.length ?? 0}`)
console.log(`open positions   ${before.openPositions} -> ${after.openPositions}`)

// The round gate is check #1 and the side check is #2, so with no active round
// the server answers `no_active_round` and this proves nothing either way. Say
// so, rather than reporting a FAIL the server did not earn — that exact false
// negative was reported as a regression once already.
const verdict =
  out.rejection?.code === 'no_active_round'
    ? 'INCONCLUSIVE - no active round, so the round gate answered before the side check. Re-run during a round.'
    : out.accepted === false && out.rejection?.code === 'invalid_side'
      ? 'PASS - rejected as invalid_side, nothing placed'
      : 'FAIL - the fix is NOT live on the deployed server'
console.log(`\n${verdict}`)

// ---- Clean up if the old behaviour created something ----------------------
if (out.accepted && out.orderId) {
  const c = await fetch(`${API}/api/orders/cancel`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ orderId: out.orderId }),
  })
  console.log(`cleanup: cancelled ${out.orderId} -> ${JSON.stringify(await c.json())}`)
}
