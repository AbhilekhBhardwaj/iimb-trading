-- A baseline reference price per instrument (USD) so LTP / charts have a value
-- before any trades occur; once trading starts, the terminal shows the real
-- last-trade price and falls back to this baseline only when a book is untraded.
-- These are placeholder marks, to be refined alongside the final instrument list.

alter table public.instruments
  add column reference_price numeric not null default 0
  constraint instruments_reference_price_nonneg check (reference_price >= 0);

comment on column public.instruments.reference_price is
  'Baseline USD price used as LTP/chart seed until the instrument trades. Placeholder marks.';

update public.instruments set reference_price = v.px
from (values
  ('AAPL', 229.50), ('NVDA', 128.40), ('TSLA', 248.90), ('XOM', 118.00),
  ('MCD', 292.00), ('KO', 62.00), ('JPM', 215.00),
  ('SPY', 572.40), ('QQQ', 486.10), ('GLD', 245.00)
) as v(ticker, px)
where public.instruments.ticker = v.ticker;