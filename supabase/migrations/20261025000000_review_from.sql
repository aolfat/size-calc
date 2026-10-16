-- Journal step 3, the review deck (docs/journal-step-3.md): "Review from" a day syncs with your account
-- (journal_review_from: 'YYYY-MM-DD' in New York, or '' for every day), so every device's deck and count agree.

-- CLOUD_KEYS in src/services/cloud.js, plus tradier_key_at (stamped by set_tradier_key); a test keeps them in step
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent',
  'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_proxy', 'journal_fees', 'journal_deck_pnl', 'journal_review_from'
));
