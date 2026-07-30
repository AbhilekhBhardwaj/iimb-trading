-- Which side was the aggressor (taker) on each trade, so the Times & Sales tape
-- can show Buy/Sell. The engine trades at the resting (maker) price; the taker
-- is the order being placed, and its side is recorded here by the service.
-- Nullable because it's metadata the engine core doesn't model.

alter table public.trades
  add column aggressor public.order_side;

comment on column public.trades.aggressor is
  'Side of the taker (aggressing) order for this trade — drives the Buy/Sell column in Times & Sales.';