-- Per-round commission rate, Master-configurable.
--
-- The rate was previously a hardcoded engine constant (COMMISSION_RATE = 0.003).
-- It is now pinned per round and settable at any time, including mid-round, on
-- the same forward-only model as rounds.usd_inr_rate: a change applies to
-- subsequent fills only, and fills already charged keep the rate they were
-- charged at (the charge was computed at fill time and is baked into
-- profiles.realized_pnl_inr).
--
-- Persisting it here — rather than leaving it in memory — is what makes a rate
-- set between rounds survive a restart.

alter table public.rounds
  add column commission_rate numeric not null default 0.003;

alter table public.rounds
  add constraint rounds_commission_rate_range check (commission_rate >= 0 and commission_rate <= 1);

comment on column public.rounds.commission_rate is
  'Commission charged per side as a fraction of trade notional for this round '
  '(0.003 = 0.30%). Set by the Master; never auto-drifts. Forward-only: fills '
  'already charged keep the rate in force at the time of the fill.';
