-- Enum types for the trading competition schema.
-- Kept in a dedicated migration so the domain vocabulary is defined once,
-- before any table that depends on it. Values mirror the engine's TypeScript
-- string-literal unions exactly (packages/engine/src/*.ts) so the DB and the
-- matching engine never drift.

-- profiles.role — who a logged-in account is in the competition.
create type public.user_role as enum ('team', 'market_maker', 'master');

-- instruments.category
create type public.instrument_category as enum ('stock', 'etf');

-- rounds.mode — mirrors engine RoundMode (packages/engine/src/rounds.ts)
create type public.round_mode as enum ('data_and_news', 'only_data', 'silent');

-- rounds.status — mirrors engine RoundStatus
create type public.round_status as enum ('pending', 'active', 'ended');

-- orders.side / trades side — mirrors engine Side (packages/engine/src/orderbook.ts)
create type public.order_side as enum ('buy', 'sell');

-- orders.type — mirrors engine OrderType
create type public.order_type as enum ('limit', 'market');

-- orders.status — mirrors engine OrderStatus
create type public.order_status as enum ('active', 'partially_filled', 'filled', 'cancelled');

-- event_log.severity — triage level for the live debugging feed.
create type public.event_severity as enum ('info', 'warning', 'error');
