/**
 * LIVE check that serializeAccountOp is active on the deployed server.
 *
 * Fires two orders from ONE account with no await between them, each sized at
 * ~60% of available margin: individually affordable, together not. With the fix
 * live exactly one is accepted and the other comes back insufficient_margin.
 *
 * Safe by construction. Both are LIMIT buys well BELOW the market, so they rest
 * and cannot fill, and both are cancelled at the end. Run as the master
 * account, which is excluded from the leaderboard.
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
  rejection?: { code?: string; requiredInr?: number; availableInr?: number }
}
interface SnapshotResponse {
  round?: { active?: boolean; id?: string }
  account: { availableMarginInr: number }
  rate: number
  instruments: { ticker: string; ltp: number }[]
}
interface PortfolioResponse {
  workingOrders?: unknown[]
  openPositions?: number
}
const L = (p: string) => readFileSync(p, 'utf8').split('\n').map((l) => l.replace('\r', ''))

const env: Record<string, string> = {}
for (const line of L('.env')) {
  const i = line.indexOf('=')
  if (i < 0 || line.trimStart().startsWith('#')) continue
  let v = line.slice(i + 1).trim()
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  env[line.slice(0, i).trim()] = v
}
const row = L('scripts/output/credentials.csv').find((l) => l.startsWith('master,'))!.split(',')

const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const { data: auth, error } = await sb.auth.signInWithPassword({
  email: usernameToEmail(row[0].trim()),
  password: row[1].trim(),
})
if (error) throw new Error(`login failed: ${error.message}`)
const H = {
  authorization: `Bearer ${auth.session!.access_token}`,
  'content-type': 'application/json',
}

const snap = (await (await fetch(`${API}/api/snapshot?ticker=AAPL&priceWindowSec=600`, { headers: H })).json()) as SnapshotResponse
if (!snap.round?.active) {
  console.log('INCONCLUSIVE - no active round; the round gate answers before the margin gate')
  process.exit(0)
}
const available: number = snap.account.availableMarginInr
const rate: number = snap.rate
const mkt: number = snap.instruments.find((i) => i.ticker === 'AAPL')!.ltp
// Well below market so a BUY rests instead of filling.
const price = Math.max(1, Math.round(mkt * 0.5 * 100) / 100)
// ~60% of available margin each: one fits, two do not.
const qty = Math.max(1, Math.floor((available * 0.6) / (price * rate)))

console.log(`round            ${snap.round.id}`)
console.log(`available margin Rs ${Math.round(available).toLocaleString('en-IN')}`)
console.log(`AAPL mark        $${mkt}   ->  resting BUY limit at $${price} (will not fill)`)
console.log(`qty each         ${qty}  =  Rs ${Math.round(qty * price * rate).toLocaleString('en-IN')} each`)
console.log(`two together     Rs ${Math.round(2 * qty * price * rate).toLocaleString('en-IN')}  (exceeds available)\n`)

const send = () =>
  fetch(`${API}/api/orders`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ ticker: 'AAPL', side: 'buy', type: 'limit', price, qty, leverage: 1 }),
  }).then((r) => r.json() as Promise<OrderResponse>)

// No await between them — the shape of a double-submit.
const [a, b] = await Promise.all([send(), send()])
console.log('order 1:', JSON.stringify(a))
console.log('order 2:', JSON.stringify(b))

const accepted = [a, b].filter((r) => r.accepted)
const rejected = [a, b].filter((r) => !r.accepted)
console.log(`\naccepted ${accepted.length}   rejected ${rejected.length}`)
for (const r of rejected) console.log(`  reason: ${r.reason} (${r.rejection?.code})`)

console.log(
  accepted.length === 1 && rejected[0]?.rejection?.code === 'insufficient_margin'
    ? '\nPASS - exactly one admitted; the margin gate held under concurrency'
    : accepted.length === 2
      ? '\nFAIL - BOTH accepted; serializeAccountOp is NOT live'
      : `\nINCONCLUSIVE - ${accepted.length} accepted, ${rejected.length} rejected`,
)

// ---- Clean up every order this created --------------------------------------
for (const r of accepted) {
  if (!r.orderId) continue
  const c = await fetch(`${API}/api/orders/cancel`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ orderId: r.orderId }),
  })
  console.log(`cleanup: cancelled ${r.orderId} -> ${JSON.stringify(await c.json())}`)
}
const final = (await (await fetch(`${API}/api/portfolio`, { headers: H })).json()) as PortfolioResponse
console.log(`final: working orders ${final.workingOrders?.length ?? 0}, open positions ${final.openPositions}`)
