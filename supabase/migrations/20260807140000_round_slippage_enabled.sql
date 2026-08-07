-- Per-round slippage-nudge toggle, Master-controlled.
--
-- Mirrors rounds.commission_enabled: purely a DISPLAY switch. It does not change
-- how orders match or what they cost — it decides only whether the post-trade
-- popup shows teams the "a limit order could have saved you $X" nudge after a
-- market order walked the book.
--
-- Defaults to true so existing rounds keep the current behaviour.

alter table public.rounds
  add column slippage_enabled boolean not null default true;

comment on column public.rounds.slippage_enabled is
  'Show the slippage nudge to teams in the post-trade popup for this round. '
  'Display-only: never affects matching, fills or settlement.';
