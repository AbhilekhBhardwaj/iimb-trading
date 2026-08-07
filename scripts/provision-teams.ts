/**
 * Team-account provisioning for the MochaTrade / IIMB trading competition.
 *
 * Teams are pre-selected by IIMB — this is NOT a self-signup flow. An admin
 * runs this once (ahead of event day) to mint every login, then hands out the
 * generated CSV. Re-running is safe: any account that already exists is skipped,
 * never duplicated or errored.
 *
 * For each account it:
 *   1. derives a sortable username (team01..team20; marketmaker; master)
 *   2. generates a readable, human-typeable password
 *   3. creates the Supabase Auth user via the ADMIN API (service-role key)
 *   4. upserts the matching public.profiles row (role, team_name, default cash)
 *   5. logs an 'account_provisioned' event to public.event_log
 * and writes newly-created credentials to a gitignored CSV.
 *
 * SECURITY: this uses the service-role key, which bypasses RLS and can create
 * users. It must ONLY ever run here, server/script-side. Never put the
 * service-role key in the browser bundle (that key is not VITE_-prefixed on
 * purpose, so Vite will not expose it).
 *
 * Run:  npx tsx scripts/provision-teams.ts
 *       (or `npm run provision`) — reads SUPABASE_SERVICE_ROLE_KEY from .env
 */

import { createClient } from '@supabase/supabase-js'
import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { teamUsername, usernameToEmail, type AppRole } from '../src/lib/accounts'

// ===========================================================================
// ROSTER — swap this list for IIMB's real team names later (one-line change).
// ===========================================================================
const TEAM_NAMES: string[] = Array.from({ length: 20 }, (_, i) => `Team ${i + 1}`)

// The market maker is exempt from the buying-power gate entirely (see
// UNLIMITED_BUYING_POWER in server/tradingService.ts) — that exemption, not this
// number, is what lets it quote at any size. This balance exists purely so its
// Portfolio shows a sensible positive figure instead of drifting negative as
// margin is posted: cash is derived as opening + realized − margin − reserved.
// ₹100 crore covers roughly 52,000 units of a $230 instrument at 1x.
const MARKET_MAKER_CASH = 1_000_000_000

// Exactly one market maker and one master account, alongside the teams.
// startingCash is optional — omit it to use the DB default (1,000,000).
const SPECIAL_ACCOUNTS: Target[] = [
  { username: 'marketmaker', role: 'market_maker', teamName: null, startingCash: MARKET_MAKER_CASH },
  { username: 'master', role: 'master', teamName: null },
]

// ---------------------------------------------------------------------------
// Paths & env
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const OUTPUT_DIR = resolve(__dirname, 'output')
const OUTPUT_PATH = resolve(OUTPUT_DIR, 'credentials.csv')

/** Minimal .env loader (no dependency): fills process.env for keys not already set. */
function loadEnv(): void {
  const envPath = resolve(REPO_ROOT, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const key = m[1]
    let val = m[2]
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = val
  }
}

loadEnv()

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL) {
  console.error('✖ Missing SUPABASE_URL (or VITE_SUPABASE_URL) in .env')
  process.exit(1)
}
if (!SERVICE_ROLE_KEY) {
  console.error(
    '✖ Missing SUPABASE_SERVICE_ROLE_KEY in .env.\n' +
      '  Get it from Supabase → Project Settings → API → service_role (secret),\n' +
      '  add a line `SUPABASE_SERVICE_ROLE_KEY=...` to .env, then re-run.\n' +
      '  Do NOT commit it or prefix it with VITE_ (that would ship it to the browser).',
  )
  process.exit(1)
}

// Admin client: service-role key, no session persistence (one-shot script).
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ---------------------------------------------------------------------------
// Password generation — readable adjective + noun + 2 digits, e.g. "SilverOtter47".
// Word-based so it is easy to read aloud / off a printed sheet under time
// pressure, which matters more here than maximal entropy. Uses crypto.randomInt
// (unbiased). Letters are unambiguously letters and digits unambiguously digits,
// so there is no 0/O or 1/l/I confusion.
// ---------------------------------------------------------------------------
const ADJECTIVES = [
  'Amber', 'Bold', 'Brave', 'Bright', 'Calm', 'Clever', 'Cosmic', 'Crisp',
  'Golden', 'Happy', 'Jolly', 'Lucky', 'Mighty', 'Noble', 'Prime', 'Quick',
  'Royal', 'Sharp', 'Silver', 'Smart', 'Solar', 'Steady', 'Sunny', 'Swift',
  'Vivid', 'Warm',
]
const NOUNS = [
  'Otter', 'Falcon', 'Tiger', 'Panda', 'Comet', 'River', 'Maple', 'Harbor',
  'Summit', 'Canyon', 'Meadow', 'Willow', 'Cobra', 'Lynx', 'Heron', 'Marlin',
  'Bison', 'Cedar', 'Quartz', 'Opal', 'Raven', 'Coral', 'Delta', 'Nimbus',
]

function generatePassword(): string {
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)]
  const noun = NOUNS[randomInt(NOUNS.length)]
  const num = randomInt(10, 100) // 10..99 — always two digits
  return `${adj}${noun}${num}`
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------
function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

type CsvRow = { username: string; password: string; teamName: string; role: AppRole }

function writeCsv(rows: CsvRow[]): void {
  mkdirSync(OUTPUT_DIR, { recursive: true })
  // Never clobber an existing sheet silently — back it up first.
  if (existsSync(OUTPUT_PATH)) {
    renameSync(OUTPUT_PATH, resolve(OUTPUT_DIR, `credentials.${Date.now()}.bak.csv`))
  }
  const header = 'username,password,team_name,role'
  const body = rows.map((r) =>
    [r.username, r.password, r.teamName, r.role].map(csvField).join(','),
  )
  writeFileSync(OUTPUT_PATH, [header, ...body].join('\n') + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------
type Target = {
  username: string
  role: AppRole
  teamName: string | null
  /** Omit to use the DB default starting_cash (1,000,000). */
  startingCash?: number
}

/** Fetch every existing auth user, keyed by email, so we can skip duplicates. */
async function existingUsersByEmail(): Promise<Map<string, string>> {
  const byEmail = new Map<string, string>()
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u.id)
    if (data.users.length < 200) break
  }
  return byEmail
}

async function main(): Promise<void> {
  const targets: Target[] = [
    ...TEAM_NAMES.map((teamName, i) => ({
      username: teamUsername(i + 1),
      role: 'team' as const,
      teamName,
    })),
    ...SPECIAL_ACCOUNTS,
  ]

  console.log(`\nProvisioning ${targets.length} accounts against ${SUPABASE_URL}\n`)

  const existing = await existingUsersByEmail()
  const created: CsvRow[] = []
  let skipped = 0

  for (const t of targets) {
    const email = usernameToEmail(t.username)
    let userId = existing.get(email.toLowerCase())

    if (userId) {
      // Auth user already exists — skip creation. We can't recover its password,
      // so it won't appear in the CSV. Still upsert the profile to self-heal any
      // partial previous run.
      await upsertProfile(userId, t)
      console.log(`  • skip    ${t.username.padEnd(12)} (already exists)`)
      skipped++
      continue
    }

    const password = generatePassword()
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // synthetic domain can't receive mail; confirm up front
      user_metadata: { username: t.username, team_name: t.teamName, role: t.role },
    })

    if (error || !data.user) {
      // Race/edge case: created between listUsers and now. Treat "exists" as skip.
      if (error && /already|exist|registered/i.test(error.message)) {
        console.log(`  • skip    ${t.username.padEnd(12)} (already exists)`)
        skipped++
        continue
      }
      throw error ?? new Error(`createUser returned no user for ${t.username}`)
    }

    userId = data.user.id
    await upsertProfile(userId, t)
    await logProvisioned(userId, t)

    created.push({ username: t.username, password, teamName: t.teamName ?? '', role: t.role })
    console.log(`  ✓ create  ${t.username.padEnd(12)} ${t.role}`)
  }

  console.log(`\nDone: ${created.length} created, ${skipped} skipped.`)

  if (created.length > 0) {
    writeCsv(created)
    console.log(`Credentials written to: ${OUTPUT_PATH}`)
    console.log('(gitignored — this file contains real passwords, never commit it)\n')
  } else {
    console.log(
      'No new accounts created — existing passwords cannot be retrieved, ' +
        'so no CSV was written.\n',
    )
  }
}

/**
 * Insert/refresh the profiles row. When startingCash is omitted the column is
 * left out of the payload so the DB default (1,000,000) applies on insert and an
 * existing value is preserved on conflict.
 */
async function upsertProfile(id: string, t: Target): Promise<void> {
  const row: {
    id: string
    username: string
    role: AppRole
    team_name: string | null
    starting_cash?: number
  } = { id, username: t.username, role: t.role, team_name: t.teamName }
  if (t.startingCash !== undefined) row.starting_cash = t.startingCash

  const { error } = await admin.from('profiles').upsert(row, { onConflict: 'id' })
  if (error) throw error
}

async function logProvisioned(accountId: string, t: Target): Promise<void> {
  const { error } = await admin.from('event_log').insert({
    account_id: accountId,
    event_type: 'account_provisioned',
    payload: { username: t.username, team_name: t.teamName, role: t.role },
    severity: 'info',
  })
  if (error) throw error
}

main().catch((err) => {
  console.error('\n✖ Provisioning failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
