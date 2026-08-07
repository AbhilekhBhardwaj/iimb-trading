/**
 * End-to-end order-flow check against the PRODUCTION database, exercising the
 * exact TradingService code the deployment runs, plus the exact client-side
 * presenters the popup renders — so the printed lines are literally what a team
 * would see.
 *
 * Uses a throwaway round id that is NOT in the deployed schedule, so real-2 and
 * real-3 stay pending for the IIMB event. Trades run on team03-team06, which
 * hold no positions; everything written is deleted again at the end.
 *
 * Run: npx tsx server/final-e2e.ts
 */

import { RoundController } from '@iimb-trading/engine'
import { orderPnlLines, toCashPosition } from '../src/lib/orderConfirm'
import { averageFillPrice, slippageNudge } from '../src/lib/slippage'
import { createAdminClient } from './supabaseAdmin'
import { TradingService } from './tradingService'

const ROUND_ID = 'final-e2e-tmp'
const TICKER = 'NVDA'
const RATE = 83
const db = createAdminClient()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`   ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function show(lines: { k: string; v: string }[]): void {
  for (const l of lines) console.log(`        ${l.k.padEnd(14)} ${l.v}`)
}

async function id(username: string): Promise<string> {
  const { data, error } = await db.from('profiles').select('id').eq('username', username).single()
  if (error || !data) throw new Error(`no such account ${username}`)
  return data.id as string
}

async function positionAsApiShape(accountId: string, instrumentId: string) {
  const { data } = await db
    .from('positions')
    .select('qty, avg_price, leverage, notional_basis_inr')
    .eq('account_id', accountId)
    .eq('instrument_id', instrumentId)
    .maybeSingle()
  if (!data) return null
  return {
    qty: Number(data.qty),
    avgPrice: Number(data.avg_price),
    leverage: Number(data.leverage),
    costBasisInr: Math.abs(Number(data.notional_basis_inr)), // API exposes it unsigned
  }
}

async function cleanup(accounts: string[], instrumentId: string): Promise<void> {
  await db.from('trades').delete().eq('round_id', ROUND_ID)
  await db.from('orders').delete().eq('round_id', ROUND_ID)
  await db.from('positions').delete().in('account_id', accounts).eq('instrument_id', instrumentId)
  await db
    .from('event_log')
    .delete()
    .in('account_id', accounts)
    .in('event_type', ['order_placed', 'order_matched', 'order_rejected', 'order_cancelled', 'commission_charged'])
  await db.from('event_log').delete().eq('payload->>roundId', ROUND_ID)
  await db.from('rounds').delete().eq('id', ROUND_ID)
  for (const a of accounts) {
    await db.from('profiles').update({ realized_pnl: 0, realized_pnl_inr: 0 }).eq('id', a)
  }
}

async function main(): Promise<void> {
  const taker = await id('team03')
  const closer = await id('team04')
  const m1 = await id('team05')
  const m2 = await id('team06')
  const accounts = [taker, closer, m1, m2]
  const { data: inst } = await db.from('instruments').select('id').eq('ticker', TICKER).single()
  const nvda = inst!.id as string

  console.log(`\nFinal end-to-end — ${TICKER}, throwaway round '${ROUND_ID}', commission ON\n`)

  console.log('0. Pre-flight (abort untouched if the test accounts are dirty):')
  for (const [name, a] of [['team03', taker], ['team04', closer], ['team05', m1], ['team06', m2]] as const) {
    const { data: p } = await db.from('profiles').select('realized_pnl_inr').eq('id', a).single()
    check(`${name} realized_pnl_inr = 0`, Number(p!.realized_pnl_inr) === 0, `${p!.realized_pnl_inr}`)
    check(`${name} has no ${TICKER} position`, (await positionAsApiShape(a, nvda)) === null)
  }
  const { count: roundTaken } = await db.from('rounds').select('id', { count: 'exact', head: true }).eq('id', ROUND_ID)
  check('throwaway round id is free', (roundTaken ?? 0) === 0)
  if (failures > 0) {
    console.log('\n✖ Pre-flight failed — nothing written.\n')
    process.exit(1)
  }

  const rounds = new RoundController([
    { id: ROUND_ID, mode: 'only_data', durationSeconds: 600, commissionEnabled: true, usdInrRate: RATE },
  ])
  const svc = new TradingService(db, rounds)
  await svc.loadInstruments()
  await svc.startRound(0)

  try {
    // --- SCENARIO 1: market BUY that walks two ask levels --------------------
    console.log('\n1. MARKET BUY 10 walking two ask levels (5 @ $230, then 5 @ $232):')
    await svc.placeOrder({ accountId: m1, ticker: TICKER, side: 'sell', type: 'limit', price: 230, qty: 5, leverage: 1 })
    await svc.placeOrder({ accountId: m2, ticker: TICKER, side: 'sell', type: 'limit', price: 232, qty: 5, leverage: 1 })

    const posBeforeBuy = await positionAsApiShape(taker, nvda)
    const buy = await svc.placeOrder({ accountId: taker, ticker: TICKER, side: 'buy', type: 'market', qty: 10, leverage: 1, markPrice: 232 })
    check('accepted', buy.accepted === true, buy.reason)
    check('bestPriceAtSubmit is the pre-walk best ask', buy.bestPriceAtSubmit === 230, `$${buy.bestPriceAtSubmit}`)
    check('walked both levels', JSON.stringify(buy.trades?.map((t) => t.price)) === '[230,232]', JSON.stringify(buy.trades?.map((t) => t.price)))

    const buyFills = (buy.trades ?? []).map((t) => ({ price: t.price, qty: t.qty }))
    const buyAvg = averageFillPrice(buyFills)!
    check('average fill = $231.00', Math.abs(buyAvg.avgFillPrice - 231) < 1e-9, `$${buyAvg.avgFillPrice}`)

    const buyLines = orderPnlLines(toCashPosition(posBeforeBuy), buyAvg.filledQty, buyAvg.avgFillPrice, RATE, 1, true)
    const buyNudge = slippageNudge({ orderType: 'market', side: 'buy', bestPrice: buy.bestPriceAtSubmit, fills: buyFills })

    console.log('\n     POPUP WOULD SHOW:')
    show([{ k: 'Filled', v: String(buyAvg.filledQty) }, { k: 'Avg Fill', v: `$${buyAvg.avgFillPrice.toFixed(2)}` }, ...buyLines])
    console.log(`\n     SLIPPAGE NOTE:\n        ${buyNudge}\n`)
    check('opening buy shows Commission only (no Gross/Net)', JSON.stringify(buyLines.map((l) => l.k)) === '["Commission"]', JSON.stringify(buyLines.map((l) => l.k)))
    check('commission = ₹575 (0.003 × 10 × 231 × 83)', buyLines[0]?.v === '−₹575', buyLines[0]?.v)
    check('nudge names the average fill $231.00', !!buyNudge?.includes('$231.00'))
    check('nudge names the limit price $230.00', !!buyNudge?.includes('at $230.00'))
    check('nudge names the saving $10.00', !!buyNudge?.includes('saved you $10.00'))

    // --- SCENARIO 2: closing market SELL at a single level -------------------
    console.log('2. MARKET SELL 10 closing the position into a single bid at $240:')
    await svc.placeOrder({ accountId: closer, ticker: TICKER, side: 'buy', type: 'limit', price: 240, qty: 10, leverage: 1 })

    const posBeforeSell = await positionAsApiShape(taker, nvda)
    check('position going in is long 10 @ basis ₹191,730', posBeforeSell?.qty === 10 && Math.abs(posBeforeSell!.costBasisInr - 191_730) < 1e-6, `${posBeforeSell?.qty} / ₹${posBeforeSell?.costBasisInr}`)

    const sell = await svc.placeOrder({ accountId: taker, ticker: TICKER, side: 'sell', type: 'market', qty: 10, leverage: 1, markPrice: 240 })
    check('accepted', sell.accepted === true, sell.reason)
    check('bestPriceAtSubmit is the best bid $240', sell.bestPriceAtSubmit === 240, `$${sell.bestPriceAtSubmit}`)

    const sellFills = (sell.trades ?? []).map((t) => ({ price: t.price, qty: t.qty }))
    const sellAvg = averageFillPrice(sellFills)!
    const sellLines = orderPnlLines(toCashPosition(posBeforeSell), -sellAvg.filledQty, sellAvg.avgFillPrice, RATE, 1, true)
    const sellNudge = slippageNudge({ orderType: 'market', side: 'sell', bestPrice: sell.bestPriceAtSubmit, fills: sellFills })

    console.log('\n     POPUP WOULD SHOW:')
    show([{ k: 'Filled', v: String(sellAvg.filledQty) }, { k: 'Avg Fill', v: `$${sellAvg.avgFillPrice.toFixed(2)}` }, ...sellLines])
    console.log(`\n     SLIPPAGE NOTE: ${sellNudge === null ? '(none — clean fill at top of book)' : sellNudge}\n`)

    check('closing sell shows all three lines', JSON.stringify(sellLines.map((l) => l.k)) === '["Gross P&L","Commission","Net P&L"]', JSON.stringify(sellLines.map((l) => l.k)))
    check('Gross = +₹7,470', sellLines[0]?.v === '+₹7,470', sellLines[0]?.v)
    check('Commission = −₹598', sellLines[1]?.v === '−₹598', sellLines[1]?.v)
    check('Net = +₹6,872', sellLines[2]?.v === '+₹6,872', sellLines[2]?.v)
    check('NO slippage nudge on a clean top-of-book fill', sellNudge === null, `${sellNudge}`)

    // --- Ledger agreement ----------------------------------------------------
    console.log('3. Ledger agreement:')
    const { data: prof } = await db.from('profiles').select('realized_pnl_inr').eq('id', taker).single()
    const stored = Number(prof!.realized_pnl_inr)
    const expected = 7_470 - (0.003 * 10 * 231 * RATE + 0.003 * 10 * 240 * RATE)
    check('stored realized_pnl_inr = gross − both fills of commission', Math.abs(stored - expected) < 1e-6, `₹${stored.toFixed(2)} vs ₹${expected.toFixed(2)}`)
    const port = (await svc.portfolio(taker)) as Record<string, any>
    check('chargesInr counts BOTH the opening and closing fees', Math.abs(Number(port.chargesInr) - (0.003 * 10 * 231 * RATE + 0.003 * 10 * 240 * RATE)) < 1e-6, `₹${Number(port.chargesInr).toFixed(2)}`)
    check('position is flat after the close', Number(port.openPositions) === 0, `${port.openPositions}`)

    await svc.endRound(600)
  } finally {
    console.log('\n4. Cleanup:')
    await cleanup(accounts, nvda)
    const t = await db.from('trades').select('id', { count: 'exact', head: true }).eq('round_id', ROUND_ID)
    const o = await db.from('orders').select('id', { count: 'exact', head: true }).eq('round_id', ROUND_ID)
    const r = await db.from('rounds').select('id', { count: 'exact', head: true }).eq('id', ROUND_ID)
    check('trades removed', (t.count ?? 0) === 0, `${t.count}`)
    check('orders removed', (o.count ?? 0) === 0, `${o.count}`)
    check('throwaway round removed', (r.count ?? 0) === 0, `${r.count}`)
    for (const a of accounts) check(`position removed for ${a.slice(0, 8)}…`, (await positionAsApiShape(a, nvda)) === null)
    for (const a of accounts) {
      const { data: p } = await db.from('profiles').select('realized_pnl_inr').eq('id', a).single()
      check(`realized_pnl_inr reset for ${a.slice(0, 8)}…`, Number(p!.realized_pnl_inr) === 0, `${p!.realized_pnl_inr}`)
    }
  }

  console.log(`\n${failures === 0 ? '✅ ALL END-TO-END CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}\n`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\n✖ e2e error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
