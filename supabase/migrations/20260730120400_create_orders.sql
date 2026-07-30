-- orders — mirrors the engine Order type (packages/engine/src/orderbook.ts).
-- Orders are placed through a server function (which validates, then feeds the
-- matching engine); clients never insert directly. RLS therefore grants SELECT
-- of one's own orders and no write policies at all.

create table public.orders (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.profiles (id) on delete cascade,
  instrument_id uuid not null references public.instruments (id),
  round_id      text not null references public.rounds (id),
  side          public.order_side not null,
  type          public.order_type not null,
  price         numeric,
  qty           numeric not null,
  remaining_qty numeric not null,
  status        public.order_status not null default 'active',
  created_at    timestamptz not null default now(),
  -- A limit order must carry a price; a market order must not (engine clears it).
  constraint orders_limit_needs_price
    check ((type = 'limit' and price is not null) or (type = 'market' and price is null)),
  constraint orders_qty_positive check (qty > 0),
  constraint orders_remaining_in_range check (remaining_qty >= 0 and remaining_qty <= qty)
);

comment on table public.orders is
  'Order records mirroring engine Order. Placed via a server function; clients read only their own.';

-- Own-orders lookups are the hot path for every participant's blotter.
create index orders_account_id_idx on public.orders (account_id);
create index orders_round_id_idx on public.orders (round_id);

alter table public.orders enable row level security;

-- SELECT: an account may read ONLY its own orders (account_id = auth.uid()).
-- Order flow is private — a team must never see rivals' resting orders or
-- intentions. No INSERT/UPDATE/DELETE policies: order placement and lifecycle
-- updates happen exclusively through the server (service role), so a client
-- cannot spoof, amend, or cancel an order by writing the table directly.
create policy "orders_select_own"
  on public.orders
  for select
  to authenticated
  using (account_id = auth.uid());
