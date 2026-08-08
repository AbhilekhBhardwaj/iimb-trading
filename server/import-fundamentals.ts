/**
 * Import data/DataBook_v1.xlsx into public.fundamentals.
 *
 * Parses the workbook directly — an .xlsx is a ZIP of XML, so no spreadsheet
 * dependency is added for a one-off import. Idempotent: upserts on
 * (ticker, metric, period_index), so re-running after a corrected data book
 * updates values in place rather than duplicating them.
 *
 * Run: npx tsx server/import-fundamentals.ts [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createAdminClient } from './supabaseAdmin'

const DRY = process.argv.includes('--dry-run')
const BOOK = resolve(process.cwd(), 'data', 'DataBook_v1.xlsx')

/** Metric blocks: the header row, then seven company rows beneath it. */
const METRICS = [
  { key: 'revenue', headerRow: 7 },
  { key: 'ebitda_margin', headerRow: 16 },
  { key: 'pat_margin', headerRow: 25 },
  { key: 'eps', headerRow: 34 },
  { key: 'debt_equity', headerRow: 43 },
] as const
const TICKERS = ['AAPL', 'NVDA', 'AMZN', 'WMT', 'TSLA', 'XOM', 'BX'] as const
/** The S&P 500 index level, which belongs to SPY rather than a company. */
const INDEX_ROW = 52
/** Columns B..V hold Base + P1..P20. */
const COLS = Array.from({ length: 21 }, (_, i) => String.fromCharCode(66 + i))

function unzipWorkbook(): { shared: string[]; sheet: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'databook-'))
  try {
    execFileSync('unzip', ['-o', '-q', BOOK, '-d', dir])
    const decode = (s: string) =>
      s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    const sharedXml = readFileSync(resolve(dir, 'xl/sharedStrings.xml'), 'utf8')
    const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')),
    )
    return { shared, sheet: readFileSync(resolve(dir, 'xl/worksheets/sheet1.xml'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const { shared, sheet } = unzipWorkbook()

/** row number -> { column letter -> value } */
const rows = new Map<number, Record<string, string | number>>()
for (const rm of sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
  const cells: Record<string, string | number> = {}
  for (const cm of rm[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const raw = cm[3].match(/<v>([\s\S]*?)<\/v>/)?.[1]
    if (raw === undefined) continue
    cells[cm[1]] = /t="s"/.test(cm[2]) ? shared[Number(raw)] : Number(raw)
  }
  rows.set(Number(rm[1]), cells)
}

interface Row {
  ticker: string
  metric: string
  period_index: number
  value: number
}
const out: Row[] = []

for (const m of METRICS) {
  TICKERS.forEach((ticker, i) => {
    const row = rows.get(m.headerRow + 1 + i)
    // Guard the layout rather than trusting it: a shifted row would otherwise
    // import one company's numbers under another's name, silently.
    if (!row || row['A'] !== ticker) {
      throw new Error(`layout mismatch: expected ${ticker} at row ${m.headerRow + 1 + i} for ${m.key}`)
    }
    COLS.forEach((col, period_index) => {
      const value = row[col]
      if (typeof value !== 'number') throw new Error(`missing ${m.key}/${ticker} at period ${period_index}`)
      out.push({ ticker, metric: m.key, period_index, value })
    })
  })
}

const indexRow = rows.get(INDEX_ROW)
if (!indexRow) throw new Error(`missing S&P 500 index row ${INDEX_ROW}`)
COLS.forEach((col, period_index) => {
  const value = indexRow[col]
  if (typeof value !== 'number') throw new Error(`missing index_level at period ${period_index}`)
  out.push({ ticker: 'SPY', metric: 'index_level', period_index, value })
})

console.log(`parsed ${out.length} rows`)
console.log(`  ${METRICS.length} metrics x ${TICKERS.length} tickers x ${COLS.length} periods = ${METRICS.length * TICKERS.length * COLS.length}`)
console.log(`  + ${COLS.length} SPY index levels`)

if (DRY) {
  console.log('\nDRY RUN — nothing written.')
  process.exit(0)
}

const admin = createAdminClient()
for (let i = 0; i < out.length; i += 500) {
  const batch = out.slice(i, i + 500)
  const { error } = await admin.from('fundamentals').upsert(batch, { onConflict: 'ticker,metric,period_index' })
  if (error) throw error
  console.log(`  upserted ${Math.min(i + 500, out.length)}/${out.length}`)
}

const { count } = await admin.from('fundamentals').select('*', { count: 'exact', head: true })
console.log(`\nfundamentals now holds ${count} rows`)
