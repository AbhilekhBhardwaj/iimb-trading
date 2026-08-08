/**
 * Full state snapshot to a gitignored JSON file, before any destructive action.
 *
 * Reset Event deletes trades, orders, positions, notifications and rounds, and
 * zeroes every account's realized P&L. None of that is recoverable afterwards,
 * so this runs first, every time.
 *
 * Read-only: it writes a file and touches nothing in the database.
 *
 * Run: npx tsx server/backup-state.ts [label]
 */
import { createAdminClient } from './supabaseAdmin'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const admin = createAdminClient()
const label = process.argv[2] ?? 'backup'

/** Page through a table so a 1,000-row PostgREST cap cannot silently truncate. */
async function dumpAll(table: string, orderBy = 'created_at'): Promise<unknown[]> {
  const out: unknown[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select('*')
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

const snapshot: Record<string, unknown> = { takenAt: new Date().toISOString(), label }

for (const [table, orderBy] of [
  ['instruments', 'ticker'],
  ['rounds', 'index'],
  ['profiles', 'username'],
  ['positions', 'account_id'],
  ['orders', 'created_at'],
  ['trades', 'created_at'],
  ['notifications', 'created_at'],
] as [string, string][]) {
  const rows = await dumpAll(table, orderBy)
  snapshot[table] = rows
  console.log(`  ${table.padEnd(14)} ${rows.length} rows`)
}

const OUT_DIR = resolve(process.cwd(), 'scripts', 'output')
mkdirSync(OUT_DIR, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const path = resolve(OUT_DIR, `pre-reset-backup-${stamp}-${label}.json`)
writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8')
console.log(`\nWritten: ${path}`)
console.log('(gitignored — scripts/output/ is excluded from version control)')
