-- Final IIMB-confirmed tradable universe: 7 stocks + 1 ETF.
--
-- Pure DATA change. Nothing in the matching engine, margin math or order
-- handling knows a ticker — TradingService.loadInstruments() reads this table
-- at boot and everything downstream is generic. No code changes accompany this.
--
-- STRATEGY: rename in place, do not delete-and-insert.
--
-- orders, trades and positions all carry instrument_id with ON DELETE NO
-- ACTION, so dropping a referenced instrument fails loudly rather than
-- cascading. Renaming the existing rows keeps every id stable, so any history
-- that does exist stays attached and no foreign key is ever violated.
--
-- Four rows are already correct and are only re-priced: AAPL, NVDA, TSLA, XOM.
-- Three are repointed to the new names, each landing in the same sector it
-- already occupied, so nothing about the row is inconsistent mid-migration:
--   JPM  (Financials)             -> BX   (Blackstone)
--   KO   (Consumer Staples)       -> WMT  (Walmart)
--   MCD  (Consumer Discretionary) -> AMZN (Amazon)
-- SPY is kept as the single ETF. GLD and QQQ are removed.
--
-- ETF choice: SPY over QQQ deliberately. The roster is already heavily
-- technology (AAPL, NVDA, AMZN, TSLA), and QQQ is a Nasdaq-100 fund that would
-- correlate closely with holdings teams already have. SPY gives a genuinely
-- different broad-market instrument to trade against them.

begin;

-- 1. Re-point the seven stocks. Prices are USD, matching the existing scale.
update public.instruments as i
set ticker           = v.ticker,
    name             = v.name,
    category         = v.category::public.instrument_category,
    sector           = v.sector,
    reference_price  = v.reference_price
from (values
  -- old_ticker, new_ticker, name,                    category, sector,                   price
  ('AAPL', 'AAPL', 'Apple Inc',            'stock', 'Technology',             225.00),
  ('NVDA', 'NVDA', 'NVIDIA Corp',          'stock', 'Technology',             130.00),
  ('MCD',  'AMZN', 'Amazon.com Inc',       'stock', 'Consumer Discretionary', 185.00),
  ('KO',   'WMT',  'Walmart Inc',          'stock', 'Consumer Staples',        80.00),
  ('TSLA', 'TSLA', 'Tesla Inc',            'stock', 'Consumer Discretionary', 260.00),
  ('XOM',  'XOM',  'Exxon Mobil Corp',     'stock', 'Energy',                 118.00),
  ('JPM',  'BX',   'Blackstone Inc',       'stock', 'Financials',             140.00)
) as v(old_ticker, ticker, name, category, sector, reference_price)
where i.ticker = v.old_ticker;

-- 2. Keep SPY as the single ETF, refreshed for consistency.
update public.instruments
set name            = 'SPDR S&P 500 ETF Trust',
    category        = 'etf'::public.instrument_category,
    sector          = 'Broad Market',
    reference_price = 572.40
where ticker = 'SPY';

-- 3. Drop the two instruments that are no longer part of the universe.
--
-- Guarded on purpose. If any order, trade or position still references them the
-- delete is skipped rather than aborting the migration, and the verification
-- below will report more than 8 rows so the operator knows to reset the event
-- first. Silently cascading away real trade history would be far worse.
delete from public.instruments i
where i.ticker in ('GLD', 'QQQ')
  and not exists (select 1 from public.orders    o where o.instrument_id = i.id)
  and not exists (select 1 from public.trades    t where t.instrument_id = i.id)
  and not exists (select 1 from public.positions p where p.instrument_id = i.id);

-- 4. Fail the migration if the result is not exactly the 8 agreed instruments.
do $$
declare
  got text;
begin
  select string_agg(ticker, ',' order by ticker) into got from public.instruments;
  if got is distinct from 'AAPL,AMZN,BX,NVDA,SPY,TSLA,WMT,XOM' then
    raise exception
      'instrument universe is "%" — expected exactly AAPL,AMZN,BX,NVDA,SPY,TSLA,WMT,XOM. '
      'If GLD/QQQ remain, they still have orders/trades/positions: reset the event, then re-run.', got;
  end if;
end $$;

commit;

comment on table public.instruments is
  'Tradable universe: 7 US stocks + 1 broad-market ETF, confirmed by IIMB. Traded in-competition as perpetual futures (contract type not modelled here; category = underlying asset class).';
