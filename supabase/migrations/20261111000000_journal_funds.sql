-- Journal (docs/journal.md): a leveraged or inverse ETF's trade reads its setup, side and charts on what it tracks (long
-- SQQQ is short QQQ). The app's built-in list knows most funds; journal_funds holds yours, synced like the other settings:
-- a JSON object of ticker → the underlying it moves with ('NVDA'), against ('-QQQ'), or '' to keep it on itself.

-- CLOUD_KEYS in src/services/cloud.js, plus the stamps the Vault functions write; a test keeps them in step
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent',
  'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_login_at', 'schwab_proxy', 'journal_fees', 'journal_deck_pnl',
  'journal_review_from', 'journal_funds'
));
