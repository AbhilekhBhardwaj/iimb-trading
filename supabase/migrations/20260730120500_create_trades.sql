-- trades — mirrors the engine Trade type (packages/engine/src/orderbook.ts).
-- A trade links the two orders that crossed. Written only by the engine.

create table public.trades (
  id            uuid primary key default gen_random_uuid(),
  buy_order_id  uuid not null references public.orders (id),
  sell_order_id uuid not null references public.orders (id),
  instrument_id uuid not null references public.instruments (id),
  round_id      text not null references public.rounds (id),
  price         numeric not null,
  qty           numeric not null,
  created_at    timestamptz not null default now()
);

comment on table public.trades is
  'Executed trades mirroring engine Trade. Written by the engine; a client sees only trades it was a party to.';

create index trades_buy_order_id_idx on public.trades (buy_order_id);
create index trades_sell_order_id_idx on public.trades (sell_order_id);
create index trades_round_id_idx on public.trades (round_id);

alter table public.trades enable row level security;

-- SELECT: an account may read a trade only if it was on the buy OR sell side.
-- Trades reference orders (not accounts) directly, so we resolve ownership
-- through the order rows. The EXISTS subqueries read public.orders, which is
-- itself RLS-protected to own-orders-only — this composes correctly: a caller
-- can see an order (and therefore match this check) exactly when it owns that
-- order, so a trade is visible iff the caller owns one of its two legs. No
-- write policies: only the engine (service role) records fills.
create policy "trades_select_own_side"
  on public.trades
  for select
  to authenticated
  using (
    exists (
      select 1 from public.orders o
      where o.id = trades.buy_order_id and o.account_id = auth.uid()
    )
    or exists (
      select 1 from public.orders o
      where o.id = trades.sell_order_id and o.account_id = auth.uid()
    )
  );
