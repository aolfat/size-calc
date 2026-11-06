-- Risk strip (CLAUDE.md, the preset chips): the % chips are editable like the $ ones, and risk_pct_presets carries them
-- to your other devices, synced like the other settings: a JSON array of percents, smallest first ([0.125,0.25,0.5,1,2,3]).

-- CLOUD_KEYS in src/services/cloud.js, plus the stamps the Vault functions write; a test keeps them in step
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'risk_pct_presets', 'atr_multiplier', 'stop_strategy',
  'stop_percent', 'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_login_at', 'schwab_proxy', 'journal_fees',
  'journal_deck_pnl', 'journal_review_from', 'journal_funds'
));
