-- instruments — the tradable universe (stocks + ETFs).
-- A DB-managed reference table: the engine refers to instruments by ticker,
-- while orders/trades/positions reference the surrogate uuid id.

create table public.instruments (
  id       uuid primary key default gen_random_uuid(),
  ticker   text not null unique,
  name     text not null,
  category public.instrument_category not null,
  sector   text
);

comment on table public.instruments is
  'Tradable universe. Public read; managed server-side. Seeded with placeholders pending IIMB''s final list.';

alter table public.instruments enable row level security;

-- SELECT: instruments are public reference data — every participant (and the
-- unauthenticated login screen) needs the ticker list to render the market.
-- Granted to both anon and authenticated. No write policies exist, so the
-- catalogue can only be changed with the service-role key.
create policy "instruments_public_read"
  on public.instruments
  for select
  to anon, authenticated
  using (true);
