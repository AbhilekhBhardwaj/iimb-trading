-- realized_pnl is now stored in USD (the P&L is locked in USD; its INR value is
-- derived at display time using the live USD→INR rate). Update the comment to
-- match; the stored values are the account's running realized P&L in USD.

comment on column public.profiles.realized_pnl is
  'Running realized P&L in USD. Written server-side by the engine on each closing/reducing/flipping fill; converted to INR at display time using the live rate. Rehydrated into memory on restart.';
