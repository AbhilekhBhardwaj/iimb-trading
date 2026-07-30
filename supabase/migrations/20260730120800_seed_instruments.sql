-- Seed the instrument universe with 10 placeholders: 7 stocks + 3 ETFs.
-- Tickers are sensible Indian large-caps / index ETFs (this is an IIMB event),
-- but are expected to be replaced with IIMB's final list later. Idempotent via
-- ON CONFLICT so re-running is harmless.

insert into public.instruments (ticker, name, category, sector) values
  ('RELIANCE',  'Reliance Industries Ltd',   'stock', 'Energy'),
  ('TCS',       'Tata Consultancy Services',  'stock', 'Information Technology'),
  ('INFY',      'Infosys Ltd',                'stock', 'Information Technology'),
  ('HDFCBANK',  'HDFC Bank Ltd',              'stock', 'Financials'),
  ('ICICIBANK', 'ICICI Bank Ltd',             'stock', 'Financials'),
  ('ITC',       'ITC Ltd',                    'stock', 'Consumer Staples'),
  ('LT',        'Larsen & Toubro Ltd',        'stock', 'Industrials'),
  ('NIFTYBEES', 'Nippon India Nifty 50 ETF',  'etf',   'Broad Market'),
  ('BANKBEES',  'Nippon India Nifty Bank ETF','etf',   'Financials'),
  ('GOLDBEES',  'Nippon India Gold ETF',      'etf',   'Commodities')
on conflict (ticker) do nothing;
