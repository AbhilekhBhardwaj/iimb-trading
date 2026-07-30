-- Realized P&L per account, so buying power survives a server restart.
-- Stored in the account's cash currency (INR, same as starting_cash) and updated
-- by the engine service whenever a fill closes/reduces/flips a position. On
-- startup the service reads this back into its in-memory running P&L.
--
-- available margin = starting_cash + realized_pnl - margin_used - margin_reserved

alter table public.profiles
  add column realized_pnl numeric not null default 0;

comment on column public.profiles.realized_pnl is
  'Running realized P&L in INR (same unit as starting_cash). Written server-side by the engine on each closing/reducing/flipping fill; rehydrated into memory on restart.';
