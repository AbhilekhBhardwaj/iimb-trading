-- Record the commission rate each fill was actually charged at.
--
-- rounds.commission_rate is the rate currently in force, and the Master may
-- change it mid-round. Without stamping the rate onto the trade, any later
-- reconstruction (Portfolio's trade history and chargesInr) would recompute old
-- fills at the NEW rate and disagree with what was really deducted from
-- profiles.realized_pnl_inr.
--
-- Exactly the role trades.usd_inr_rate already plays for the FX rate.

alter table public.trades
  add column commission_rate numeric;

comment on column public.trades.commission_rate is
  'Commission rate this fill was charged at, as a fraction of notional per side. '
  'Null for trades predating per-round commission rates (reconstruction falls '
  'back to the round rate, then to the engine default).';
