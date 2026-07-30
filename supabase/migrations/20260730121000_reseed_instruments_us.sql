-- Replace the placeholder Indian instruments with the real US universe.
-- We UPDATE the existing 10 rows in place (matched by their old ticker) rather
-- than delete+insert, so each instrument keeps its uuid id and any future FK
-- references stay intact. The earlier seed migration is left untouched.
--
-- These underlyings are traded in the competition as perpetual futures. The
-- current schema has no column for contract type (category is only
-- 'stock' | 'etf', describing the underlying asset class), so the perp framing
-- is recorded in the table comment only; add a contract_type column later if it
-- needs to be queryable.
--
-- Composition (per the competition's instrument-design rules):
--   * AAPL + GPRO   — same industry (Technology), different size (large vs small cap)
--   * TSLA vs XOM   — substitute pair across sectors (electric vs fossil-fuel mobility)
--   * MCD + KO      — complementary pair across sectors (Coke served with the meal)
--   * JPM           — liquid large-cap rounding out the set (Financials)
--   * SPY + QQQ     — two similar broad-market US ETFs (highly correlated)
--   * GLD           — differentiated commodity (gold) ETF

update public.instruments as i
set ticker   = v.ticker,
    name     = v.name,
    category = v.category::public.instrument_category,
    sector   = v.sector
from (values
  -- old_ticker,  new_ticker, name,                        category, sector
  ('RELIANCE',   'AAPL', 'Apple Inc',                  'stock', 'Technology'),
  ('TCS',        'GPRO', 'GoPro Inc',                  'stock', 'Technology'),
  ('INFY',       'XOM',  'Exxon Mobil Corp',           'stock', 'Energy'),
  ('HDFCBANK',   'JPM',  'JPMorgan Chase & Co',        'stock', 'Financials'),
  ('ICICIBANK',  'TSLA', 'Tesla Inc',                  'stock', 'Consumer Discretionary'),
  ('ITC',        'KO',   'The Coca-Cola Company',      'stock', 'Consumer Staples'),
  ('LT',         'MCD',  'McDonald''s Corp',           'stock', 'Consumer Discretionary'),
  ('NIFTYBEES',  'SPY',  'SPDR S&P 500 ETF Trust',     'etf',   'Broad Market'),
  ('BANKBEES',   'QQQ',  'Invesco QQQ Trust',          'etf',   'Broad Market'),
  ('GOLDBEES',   'GLD',  'SPDR Gold Shares',           'etf',   'Commodities')
) as v(old_ticker, ticker, name, category, sector)
where i.ticker = v.old_ticker;

comment on table public.instruments is
  'Tradable universe: real US stocks & ETFs, traded in-competition as perpetual futures (contract type not modelled here; category = underlying asset class).';
