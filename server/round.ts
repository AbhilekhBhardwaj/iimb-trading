/**
 * Round control CLI — logs in as `master` and starts/ends a round via the API.
 * Requires the API server to be running (`npm run api`).
 *
 *   npx tsx server/round.ts start   # begin the next round
 *   npx tsx server/round.ts end     # end the active round
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { usernameToEmail } from '../src/lib/accounts'
import { createAdminClient } from './supabaseAdmin'

const action = process.argv[2] === 'end' ? 'end' : 'start'
const BASE = process.env.API_BASE ?? 'http://localhost:8787'
const HERE = dirname(fileURLToPath(import.meta.url))

createAdminClient() // side effect: loads .env
const SUPABASE_URL = process.env.SUPABASE_URL!
const ANON = process.env.SUPABASE_ANON_KEY!

function masterPassword(): string {
  const csv = readFileSync(resolve(HERE, '..', 'scripts', 'output', 'credentials.csv'), 'utf8')
  for (const line of csv.split(/\r?\n/)) {
    const [username, password] = line.split(',')
    if (username === 'master') return password
  }
  throw new Error("no 'master' row in scripts/output/credentials.csv")
}

async function main(): Promise<void> {
  const anon = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({
    email: usernameToEmail('master'),
    password: masterPassword(),
  })
  if (error || !data.session) throw new Error(`master login failed: ${error?.message}`)

  const res = await fetch(`${BASE}/api/round/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${data.session.access_token}`, 'content-type': 'application/json' },
  })
  console.log(`round ${action} →`, JSON.stringify(await res.json(), null, 2))
}

main().catch((err) => {
  console.error('✖', err instanceof Error ? err.message : err)
  process.exit(1)
})
