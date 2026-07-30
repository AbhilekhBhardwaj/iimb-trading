-- Margin trading needs a leverage per order and per position; neither table
-- carried it yet. Leverage is an account-side concept (the engine order book is
-- currency/leverage-agnostic), so it lives in the DB rows, not the engine types.
--
-- Default 1 (= no leverage) keeps every existing row valid and is the safe
-- fallback when a caller omits it. leverage >= 1 by construction.

alter table public.orders
  add column leverage numeric not null default 1
  constraint orders_leverage_min check (leverage >= 1);

comment on column public.orders.leverage is
  'Chosen leverage for this order (>=1). Sets/opens a position''s leverage; ignored when merely adding to an existing position (which keeps its own).';

alter table public.positions
  add column leverage numeric not null default 1
  constraint positions_leverage_min check (leverage >= 1);

comment on column public.positions.leverage is
  'Effective leverage of the current open position. Isolated margin = |qty| * avg_price / leverage.';
