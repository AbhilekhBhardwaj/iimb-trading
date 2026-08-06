-- INR cash settlement — replaces continuous mark-to-market for teams.
--
-- Positions are now settled in INR at the rate prevailing at each fill:
-- opening/adding posts margin (notional / leverage) as a cash debit, holding
-- never revalues, and closing releases margin plus realizes P&L against the
-- original INR basis. See packages/engine/src/cash.ts for the model.

-- 1. Positions carry their FULL INR notional basis (NOT divided by leverage).
--    Posted margin is derived as abs(notional_basis_inr) / leverage, so only
--    the basis is stored. Fixed at fill time; never revalued while held.
alter table public.positions
  add column notional_basis_inr numeric not null default 0;

comment on column public.positions.notional_basis_inr is
  'Full INR notional committed at entry (NOT divided by leverage), signed like qty. '
  'Fixed at fill time. Posted margin = abs(notional_basis_inr) / leverage.';

-- Backfill any pre-existing holding at the legacy fixed rate so posted margin
-- and P&L stay coherent for positions opened before this migration.
update public.positions
   set notional_basis_inr = qty * avg_price * 83
 where qty <> 0;

-- 2. The USD->INR rate is PINNED PER ROUND and only ever changes when the
--    Master changes it. It must not drift: under cash settlement a rate move
--    realizes real P&L on every close, so drift would silently inject P&L from
--    currency movement alone.
alter table public.rounds
  add column usd_inr_rate numeric not null default 83;

alter table public.rounds
  add constraint rounds_usd_inr_rate_positive check (usd_inr_rate > 0);

comment on column public.rounds.usd_inr_rate is
  'USD->INR rate in force for this round. Set by the Master; never auto-drifts.';

-- 3. Each trade records the rate it settled at, so trade history is exactly
--    reproducible even if the Master changes the rate part-way through a round.
alter table public.trades
  add column usd_inr_rate numeric;

comment on column public.trades.usd_inr_rate is
  'USD->INR rate this fill settled at. Null for trades predating INR settlement '
  '(history replay falls back to the round rate, then to 83).';

-- 4. Realized P&L is now inherently INR: it is the difference between two INR
--    amounts struck at two different rates, so it cannot be stored in USD
--    without losing information. profiles.realized_pnl (USD) is superseded.
alter table public.profiles
  add column realized_pnl_inr numeric not null default 0;

comment on column public.profiles.realized_pnl_inr is
  'Running realized P&L in INR under cash settlement. Authoritative. '
  'Supersedes realized_pnl (USD), which is retained only for historical audit '
  'and is no longer written.';

update public.profiles
   set realized_pnl_inr = realized_pnl * 83
 where realized_pnl <> 0;

comment on column public.profiles.realized_pnl is
  'DEPRECATED (USD). Superseded by realized_pnl_inr under INR cash settlement; '
  'no longer written by the engine. Retained for historical audit only.';
