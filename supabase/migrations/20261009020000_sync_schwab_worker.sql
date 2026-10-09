-- The Schwab worker URL syncs like the other settings, so a new device only has to log in. It's an address, not a
-- secret; the Schwab login itself stays on each device.
alter table public.settings drop constraint settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier',
  'stop_strategy', 'stop_percent', 'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_proxy'
));
