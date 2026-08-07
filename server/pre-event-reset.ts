/**
 * ONE-OFF pre-event reset. Backs the current state up to a JSON file, then
 * clears all trading state so the deployed schedule returns to a pristine
 * 1 mock + 3 scored rounds, every team flat with zero P&L.
 *
 * DESTRUCTIVE. Deletes the Aug 5 session's trades, orders, rounds, positions,
 * notifications and round-tagged event_log rows. The 22 account_provisioned
 * event_log records are KEPT so team accounts stay auditable.
 *
 * A Railway RESTART is required afterwards: the running process holds round
 * statuses in memory, so clearing the table alone does not change what
 * `round/start` hands out. Delete first, restart second — rehydrate() then finds
 * an empty rounds table and marks all four pending.
 *
 * Run: npx tsx server/pre-event-reset.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAdminClient } from './supabaseAdmin'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '..', 'scripts', 'output')
const db = createAdminClient()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

async function all(table: string): Promise<unknown[]> {
  const { data, error } = await db.from(table).select('*')
  if (error) throw new Error(`reading ${table}: ${error.message}`)
  return data ?? []
}

async function count(table: string): Promise<number> {
  const { count: n, error } = await db.from(table).select('*', { count: 'exact', head: true })
  if (error) throw new Error(`counting ${table}: ${error.message}`)
  return n ?? 0
}

async function main(): Promise<void> {
  console.log('\nPre-event reset — production database\n')

  // --- 1. Back everything up BEFORE touching a row -------------------------
  console.log('1. Backup:')
  const backup = {
    takenAt: new Date().toISOString(),
    note: 'Pre-event reset. Aug 5 session state, captured before clearing trading data.',
    trades: await all('trades'),
    orders: await all('orders'),
    rounds: await all('rounds'),
    positions: await all('positions'),
    notifications: await all('notifications'),
    event_log: await all('event_log'),
    profiles: await all('profiles'),
  }
  mkdirSync(OUT_DIR, { recursive: true })
  const stamp = backup.takenAt.replace(/[:.]/g, '-')
  const file = resolve(OUT_DIR, `pre-event-backup-${stamp}.json`)
  writeFileSync(file, JSON.stringify(backup, null, 2), 'utf8')
  console.log(`   → ${file}`)
  check('trades backed up', backup.trades.length > 0, `${backup.trades.length}`)
  check('orders backed up', backup.orders.length > 0, `${backup.orders.length}`)
  check('rounds backed up', backup.rounds.length > 0, `${backup.rounds.length}`)
  check('positions backed up', backup.positions.length > 0, `${backup.positions.length}`)
  check('profiles backed up', backup.profiles.length === 22, `${backup.profiles.length}`)
  check('event_log backed up', backup.event_log.length > 0, `${backup.event_log.length}`)
  if (failures > 0) {
    console.log('\n✖ Backup incomplete — refusing to delete anything.\n')
    process.exit(1)
  }

  // --- 2. Delete in FK-safe order ------------------------------------------
  // trades reference orders AND rounds; orders reference rounds. Children first.
  console.log('\n2. Clearing trading state (FK-safe order):')
  // PostgrestFilterBuilder is thenable but not a real Promise, so the thunk is
  // typed as PromiseLike rather than Promise.
  const steps: [string, () => PromiseLike<{ error: { message: string } | null }>][] = [
    ['trades', () => db.from('trades').delete().neq('id', '00000000-0000-0000-0000-000000000000')],
    ['orders', () => db.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000')],
    ['positions', () => db.from('positions').delete().neq('account_id', '00000000-0000-0000-0000-000000000000')],
    ['notifications', () => db.from('notifications').delete().neq('id', '00000000-0000-0000-0000-000000000000')],
    // Keep account_provisioned: those 22 rows are the accounts' own audit trail.
    ['event_log (except account_provisioned)', () => db.from('event_log').delete().neq('event_type', 'account_provisioned')],
    ['rounds', () => db.from('rounds').delete().neq('id', '')],
  ]
  for (const [label, run] of steps) {
    const { error } = await run()
    check(`cleared ${label}`, !error, error?.message)
    if (error) {
      console.log('\n✖ Deletion failed part-way. Restore from the backup above before retrying.\n')
      process.exit(1)
    }
  }

  console.log('\n3. Resetting P&L on all accounts:')
  const { error: pnlErr } = await db
    .from('profiles')
    .update({ realized_pnl: 0, realized_pnl_inr: 0 })
    .neq('id', '00000000-0000-0000-0000-000000000000')
  check('realized_pnl and realized_pnl_inr zeroed', !pnlErr, pnlErr?.message)

  // --- 3. Verify the end state ---------------------------------------------
  console.log('\n4. Verification:')
  check('trades empty', (await count('trades')) === 0)
  check('orders empty', (await count('orders')) === 0)
  check('rounds empty', (await count('rounds')) === 0)
  check('positions empty', (await count('positions')) === 0)
  check('notifications empty', (await count('notifications')) === 0)
  check('all 22 profiles retained', (await count('profiles')) === 22)

  const { count: provisioned } = await db
    .from('event_log')
    .select('*', { count: 'exact', head: true })
    .eq('event_type', 'account_provisioned')
  check('account_provisioned records kept', (provisioned ?? 0) === 22, `${provisioned}`)
  check('no other event_log rows remain', (await count('event_log')) === (provisioned ?? 0))

  const { data: dirty } = await db
    .from('profiles')
    .select('username, realized_pnl, realized_pnl_inr')
    .or('realized_pnl.neq.0,realized_pnl_inr.neq.0')
  check('no account carries residual P&L', (dirty ?? []).length === 0, JSON.stringify(dirty))

  console.log(`\n${failures === 0 ? '✅ RESET COMPLETE' : `❌ ${failures} CHECK(S) FAILED`}`)
  console.log('\n⚠  NOT DONE YET: restart the Railway service.')
  console.log('   The running process still holds mock-1 and real-1 as ended in memory.')
  console.log('   After a restart, rehydrate() reads an empty rounds table and all four')
  console.log('   rounds (mock-1, real-1, real-2, real-3) come back as pending.\n')
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ reset error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
