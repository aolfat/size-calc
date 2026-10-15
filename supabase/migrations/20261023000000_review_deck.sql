-- Journal step 3, slice 2 (docs/journal-step-3.md): the review deck. "Save for the weekly review" marks a trade
-- (trade_reviews.weekly_at, null = not saved; slice 6's weekly review reads it), and the deck's "P&L hidden until you
-- grade" choice syncs with your account (journal_deck_pnl: 'graded' or 'always').

alter table public.trade_reviews add column if not exists weekly_at timestamptz;

-- CLOUD_KEYS in src/services/cloud.js, plus tradier_key_at (stamped by set_tradier_key); a test keeps them in step
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent',
  'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_proxy', 'journal_fees', 'journal_deck_pnl'
));
