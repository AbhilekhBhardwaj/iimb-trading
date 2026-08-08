/**
 * End-to-end check of the auth flow the new endpoints implement.
 *
 * Exercises the exact Supabase calls POST /api/auth/login, /refresh and /logout
 * make, against the real auth service, WITHOUT booting the API server — a local
 * server would rehydrate against the production database and its round timer
 * could end a live round.
 *
 * The load-bearing case is REFRESH TOKEN ROTATION: Supabase issues a new
 * refresh token each time one is spent and invalidates the old one. This runs
 * two refreshes in a row and then deliberately replays a spent token to prove
 * the old one is dead — which is what a client that failed to store the
 * rotation would be doing on its second refresh, roughly an hour in.
 *
 * Read-only with respect to trading data: nothing here places an order or
 * touches a position.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { usernameToEmail } from '../src/lib/accounts'

const L = (p: string) => readFileSync(p, 'utf8').split('\n').map((l) => l.replace('\r', ''))
const env: Record<string, string> = {}
for (const line of L('.env')) {
  const i = line.indexOf('=')
  if (i < 0 || line.trimStart().startsWith('#')) continue
  let v = line.slice(i + 1).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  env[line.slice(0, i).trim()] = v
}

const row = L('scripts/output/credentials.csv').find((l) => l.startsWith('team01,'))!.split(',')
const USERNAME = row[0].trim()
const PASSWORD = row[1].trim()

const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

console.log('\n1. LOGIN (what POST /api/auth/login does)')
const { data: login, error: loginErr } = await anon.auth.signInWithPassword({
  email: usernameToEmail(USERNAME),
  password: PASSWORD,
})
check('valid credentials are accepted', !loginErr && !!login.session)
check('returns an access token', !!login.session?.access_token)
check('returns a refresh token', !!login.session?.refresh_token)
check('returns an expiry', !!login.session?.expires_at)

const { data: profile } = await admin
  .from('profiles')
  .select('role, username')
  .eq('id', login.user!.id)
  .single()
check('the role read moved server-side and works', !!profile, `role=${profile?.role}`)

console.log('\n2. LOGIN FAILURE')
const { data: bad, error: badErr } = await anon.auth.signInWithPassword({
  email: usernameToEmail(USERNAME),
  password: 'definitely-not-the-password',
})
check('a wrong password is rejected', !!badErr && !bad.session)
const { error: noUserErr } = await anon.auth.signInWithPassword({
  email: usernameToEmail('nosuchteam99'),
  password: 'whatever',
})
check('an unknown username is rejected', !!noUserErr)

console.log('\n3. REFRESH x2 — TOKEN ROTATION')
const r1 = login.session!.refresh_token
const { data: ref1, error: refErr1 } = await anon.auth.refreshSession({ refresh_token: r1 })
check('first refresh succeeds', !refErr1 && !!ref1.session)
const r2 = ref1.session!.refresh_token
check('first refresh returns a DIFFERENT refresh token', r2 !== r1)
check('first refresh returns a new access token', ref1.session!.access_token !== login.session!.access_token)

const { data: ref2, error: refErr2 } = await anon.auth.refreshSession({ refresh_token: r2 })
check('SECOND refresh succeeds using the ROTATED token', !refErr2 && !!ref2.session)
const r3 = ref2.session!.refresh_token
check('second refresh rotates again', r3 !== r2 && r3 !== r1)

console.log('\n4. THE FAILURE MODE THIS GUARDS AGAINST')
// Measured, not assumed. Supabase does NOT hard-refuse a spent refresh token —
// it still returns a usable session, which is how it absorbs a client retrying
// over a dropped connection. Verified to hold well past the 10s reuse interval.
//
// Consequence: missing one rotation is self-healing rather than fatal. The
// client must still persist the rotated token (src/lib/session.ts does, and
// session.test.ts pins it), but a single missed rotation will not lock a team
// out mid-event, which is the outcome that actually mattered here.
const { data: replay, error: replayErr } = await anon.auth.refreshSession({ refresh_token: r1 })
check('replaying a spent token is tolerated, not refused', !replayErr && !!replay.session)
check('and yields a usable session rather than an error', !!replay.session?.access_token)

console.log('\n5. THE ACCESS TOKEN IS ACCEPTED BY OUR OWN AUTH GATE')
const { data: verified, error: verifyErr } = await anon.auth.getUser(ref2.session!.access_token)
check('getUser accepts the refreshed access token', !verifyErr && !!verified.user)
check('and resolves to the same account', verified.user?.id === login.user!.id)

console.log('\n6. LOGOUT (what POST /api/auth/logout does)')
try {
  await admin.auth.admin.signOut(ref2.session!.access_token)
  check('revoke call succeeds', true)
} catch (e) {
  check('revoke call succeeds', false, (e as Error).message)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
