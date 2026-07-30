-- positions — current holding per (account, instrument).
-- qty may be negative to represent a short position. Maintained by the engine
-- as fills settle; the composite primary key gives one row per holding and a
-- natural upsert target.

create table public.positions (
  account_id    uuid not null references public.profiles (id) on delete cascade,
  instrument_id uuid not null references public.instruments (id),
  qty           numeric not null default 0,
  avg_price     numeric not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (account_id, instrument_id)
);

comment on table public.positions is
  'Per-account holdings (qty negative = short). Maintained by the engine; a client reads only its own.';

alter table public.positions enable row level security;

-- SELECT: an account may read ONLY its own positions (account_id = auth.uid()).
-- Holdings are private competitive information. No write policies: positions
-- are recomputed by the engine (service role) from fills, so a client can
-- never fabricate a holding by writing the table directly.
create policy "positions_select_own"
  on public.positions
  for select
  to authenticated
  using (account_id = auth.uid());
