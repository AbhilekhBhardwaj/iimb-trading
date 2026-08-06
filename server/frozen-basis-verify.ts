/**
 * Live verification against the PRODUCTION Supabase project: does a buy lock a
 * fixed INR cost basis, and does that position stay completely unchanged when
 * the market price moves afterwards?
 *
 * Deliberately uses a THROWAWAY round id that is not part of the deployed event
 * schedule (mock-1, real-1, real-2, real-3), so the live server's round
 * progression is never consumed. Trades run on team03-team06, which hold no
 * positions, so every row written here is pure delta and can be deleted again.
 *
 * Everything written is removed at the end and realized_pnl_inr is restored to
 * the values captured before the run; the script re-reads the DB afterwards and
 * fails loudly if the restored state does not match the snapshot exactly.
 *
 * Run: npx tsx server/frozen-basis-verify.ts
 */

import { RoundController } from '@iimb-trading/engine'
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'

const ROUND_ID = 'frozen-basis-verify-tmp'
const TICKER = 'NVDA'
const RATE = 83
const P1 = 180 // entry price for the position under test
const P2 = 260 // later, unrelated print that moves the mark
const QTY = 10

const db = createAdminClient()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

async function resolveId(table: 'profiles' | 'instruments', col: string, val: string): Promise<string> {
  const { data, error } = await db.from(table).select('id').eq(col, val).single()
  if (error || !data) throw new Error(`could not resolve ${table}.${col}=${val}: ${error?.message}`)
  return data.id as string
}

interface PnlSnap {
  id: string
  username: string
  realized_pnl: number
  realized_pnl_inr: number
}

async function pnlSnapshot(ids: string[]): Promise<PnlSnap[]> {
  const { data, error } = await db
    .from('profiles')
    .select('id, username, realized_pnl, realized_pnl_inr')
    .in('id', ids)
    .order('username')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    username: r.username as string,
    realized_pnl: Number(r.realized_pnl),
    realized_pnl_inr: Number(r.realized_pnl_inr),
  }))
}

async function positionRow(accountId: string, instrumentId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from('positions')
    .select('account_id, instrument_id, qty, avg_price, leverage, notional_basis_inr')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/** Deletes only what this run created, then restores the captured P&L values. */
async function cleanup(accountIds: string[], instrumentId: string, pnlBefore: PnlSnap[]): Promise<void> {
  await db.from('trades').delete().eq('round_id', ROUND_ID)
  await db.from('orders').delete().eq('round_id', ROUND_ID)
  await db.from('positions').delete().in('account_id', accountIds).eq('instrument_id', instrumentId)
  await db
    .from('event_log')
    .delete()
    .in('account_id', accountIds)
    .in('event_type', ['order_placed', 'order_matched', 'order_rejected', 'order_cancelled'])
  await db.from('event_log').delete().eq('payload->>roundId', ROUND_ID)
  await db.from('rounds').delete().eq('id', ROUND_ID)
  for (const p of pnlBefore) {
    await db
      .from('profiles')
      .update({ realized_pnl: p.realized_pnl, realized_pnl_inr: p.realized_pnl_inr })
      .eq('id', p.id)
  }
}

async function main(): Promise<void> {
  const seller = await resolveId('profiles', 'username', 'team03')
  const buyer = await resolveId('profiles', 'username', 'team04')
  const moverSell = await resolveId('profiles', 'username', 'team05')
  const moverBuy = await resolveId('profiles', 'username', 'team06')
  const accounts = [seller, buyer, moverSell, moverBuy]
  const nvda = await resolveId('instruments', 'ticker', TICKER)

  console.log(`\nFrozen-basis live verification — ${TICKER}, throwaway round '${ROUND_ID}'\n`)

  // --- Pre-flight: these four accounts must be clean, or we abort untouched ---
  console.log('0. Pre-flight (refuse to run if the test accounts are not clean):')
  const pnlBefore = await pnlSnapshot(accounts)
  for (const p of pnlBefore) {
    check(`${p.username} realized_pnl_inr = 0`, p.realized_pnl_inr === 0, `${p.realized_pnl_inr}`)
  }
  for (const id of accounts) {
    const existing = await positionRow(id, nvda)
    check(`no pre-existing ${TICKER} position for ${id.slice(0, 8)}…`, existing === null)
  }
  const { count: roundExists } = await db
    .from('rounds')
    .select('id', { count: 'exact', head: true })
    .eq('id', ROUND_ID)
  check(`throwaway round id '${ROUND_ID}' is not already in use`, (roundExists ?? 0) === 0)
  if (failures > 0) {
    console.log('\n✖ Pre-flight failed — aborting WITHOUT writing anything.\n')
    process.exit(1)
  }

  const rounds = new RoundController([
    { id: ROUND_ID, mode: 'only_data', durationSeconds: 600, commissionEnabled: false, usdInrRate: RATE },
  ])
  const svc = new TradingService(db, rounds)
  await svc.loadInstruments()
  await svc.startRound(0)

  try {
    // --- 1. The buy: team04 lifts team03's offer at P1 -----------------------
    console.log(`\n1. team04 buys ${QTY} ${TICKER} @ $${P1} (rate ₹${RATE}/$), leverage 1:`)
    await svc.placeOrder({ accountId: seller, ticker: TICKER, side: 'sell', type: 'limit', price: P1, qty: QTY, leverage: 1 })
    const fill = await svc.placeOrder({ accountId: buyer, ticker: TICKER, side: 'buy', type: 'limit', price: P1, qty: QTY, leverage: 1 })
    check('buy accepted and matched', fill.accepted === true && (fill.trades?.length ?? 0) === 1, `trades=${fill.trades?.length}`)

    const posBefore = await positionRow(buyer, nvda)
    const expectedBasis = QTY * P1 * RATE
    check(
      `notional_basis_inr = ₹${expectedBasis.toLocaleString('en-IN')} (qty × price × rate)`,
      Number(posBefore?.notional_basis_inr) === expectedBasis,
      `₹${Number(posBefore?.notional_basis_inr).toLocaleString('en-IN')}`,
    )
    check('avg_price = entry price', Number(posBefore?.avg_price) === P1, `$${posBefore?.avg_price}`)

    const portBefore = await svc.portfolio(buyer)
    const invBefore: any = (portBefore.inventory as any[]).find((r) => r.ticker === TICKER)
    console.log(
      `   → ltp $${invBefore.ltp}, costBasisInr ₹${invBefore.costBasisInr.toLocaleString('en-IN')}, ` +
        `entryRateInr ₹${invBefore.entryRateInr}, marginUsedInr ₹${invBefore.marginUsedInr.toLocaleString('en-IN')}`,
    )
    console.log(
      `   → totalPortfolioValueInr ₹${Number(portBefore.totalPortfolioValueInr).toLocaleString('en-IN')}, ` +
        `totalPnlInr ₹${Number(portBefore.totalPnlInr).toLocaleString('en-IN')}`,
    )

    // --- 2. Move the mark with a trade between two OTHER accounts ------------
    console.log(`\n2. team05 → team06 print 1 ${TICKER} @ $${P2}, moving the mark (team04 untouched):`)
    await svc.placeOrder({ accountId: moverSell, ticker: TICKER, side: 'sell', type: 'limit', price: P2, qty: 1, leverage: 1 })
    await svc.placeOrder({ accountId: moverBuy, ticker: TICKER, side: 'buy', type: 'limit', price: P2, qty: 1, leverage: 1 })
    check(`ltp really moved $${P1} → $${P2}`, svc.ltp(TICKER) === P2, `$${svc.ltp(TICKER)}`)

    // --- 3. The assertion: team04's position is bit-identical -----------------
    console.log('\n3. team04 position and equity AFTER the price move:')
    const posAfter = await positionRow(buyer, nvda)
    const portAfter = await svc.portfolio(buyer)
    const invAfter: any = (portAfter.inventory as any[]).find((r) => r.ticker === TICKER)

    check('qty unchanged', Number(posAfter?.qty) === Number(posBefore?.qty), `${posAfter?.qty}`)
    check('avg_price unchanged', Number(posAfter?.avg_price) === Number(posBefore?.avg_price), `$${posAfter?.avg_price}`)
    check(
      'notional_basis_inr unchanged',
      Number(posAfter?.notional_basis_inr) === Number(posBefore?.notional_basis_inr),
      `₹${Number(posAfter?.notional_basis_inr).toLocaleString('en-IN')}`,
    )
    check('costBasisInr unchanged', invAfter.costBasisInr === invBefore.costBasisInr, `₹${invAfter.costBasisInr.toLocaleString('en-IN')}`)
    check('entryRateInr unchanged', invAfter.entryRateInr === invBefore.entryRateInr, `₹${invAfter.entryRateInr}`)
    check('marginUsedInr unchanged', invAfter.marginUsedInr === invBefore.marginUsedInr, `₹${invAfter.marginUsedInr.toLocaleString('en-IN')}`)
    check(
      'totalPortfolioValueInr unchanged',
      portAfter.totalPortfolioValueInr === portBefore.totalPortfolioValueInr,
      `₹${Number(portAfter.totalPortfolioValueInr).toLocaleString('en-IN')}`,
    )
    check('totalPnlInr still 0 (nothing realized)', Number(portAfter.totalPnlInr) === 0, `₹${portAfter.totalPnlInr}`)
    check('no unrealized field is exposed at all', !('unrealizedPnlInr' in portAfter) && !('unrealizedPnlInr' in invAfter))
    console.log(`   → ltp is now $${invAfter.ltp} (the mark DID move) but costBasisInr is still ₹${invAfter.costBasisInr.toLocaleString('en-IN')}`)

    await svc.endRound(600)
  } finally {
    // --- 4. Scoped cleanup, then prove the restore is exact ------------------
    console.log('\n4. Cleanup (scoped to this run only):')
    await cleanup(accounts, nvda, pnlBefore)

    const leftoverTrades = await db.from('trades').select('id', { count: 'exact', head: true }).eq('round_id', ROUND_ID)
    const leftoverOrders = await db.from('orders').select('id', { count: 'exact', head: true }).eq('round_id', ROUND_ID)
    const leftoverRound = await db.from('rounds').select('id', { count: 'exact', head: true }).eq('id', ROUND_ID)
    check('no trades left from this run', (leftoverTrades.count ?? 0) === 0, `${leftoverTrades.count}`)
    check('no orders left from this run', (leftoverOrders.count ?? 0) === 0, `${leftoverOrders.count}`)
    check('throwaway round row removed', (leftoverRound.count ?? 0) === 0, `${leftoverRound.count}`)
    for (const id of accounts) {
      check(`${TICKER} position removed for ${id.slice(0, 8)}…`, (await positionRow(id, nvda)) === null)
    }
    const pnlAfter = await pnlSnapshot(accounts)
    for (const before of pnlBefore) {
      const after = pnlAfter.find((p) => p.id === before.id)!
      check(
        `${before.username} realized_pnl_inr restored to ${before.realized_pnl_inr}`,
        after.realized_pnl_inr === before.realized_pnl_inr,
        `${after.realized_pnl_inr}`,
      )
    }
  }

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ verification error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
