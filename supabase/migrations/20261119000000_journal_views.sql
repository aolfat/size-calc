-- Saved views in the Journal's More filters (docs/journal.md): journal_views follows you to every device, synced like
-- the other settings: a JSON array of views, each a name and what it sets ([{"name":"Stretched","side":"long",
-- "filters":[{"field":"feature:atr_from_daily_sma50","op":"atleast","min":4}]}]), within the 2000 characters a setting holds.

-- CLOUD_KEYS in src/services/cloud.js, plus the stamps the Vault functions write; a test keeps them in step
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'risk_pct_presets', 'atr_multiplier', 'stop_strategy',
  'stop_percent', 'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_login_at', 'schwab_proxy', 'journal_fees',
  'journal_deck_pnl', 'journal_review_from', 'journal_funds', 'journal_views'
));
