-- Trade features, part 2 (docs/journal-features.md): what the data says about each trade at its entry (SPY over its daily
-- 8 EMA, the entry against VWAP, the volume run rate, the distance from the all-time high, and the many to come), worked
-- out by the app. One row per (user, trade key), every feature in one JSON object, so hundreds of features stay one row
-- a trade: { "<feature key>": { "v": "<family version>.<feature version>", "value": <number, word or null>, "note": "..." } }.
-- A null value is unknown for good (the data is gone); a feature still waiting for its data isn't in it at all.

create table if not exists public.trade_features (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trade_key text not null check (length(trade_key) between 1 and 200),
  stamps jsonb not null default '{}'::jsonb check (jsonb_typeof(stamps) = 'object' and octet_length(stamps::text) <= 200000),
  updated_at timestamptz not null default now(),
  primary key (user_id, trade_key)
);

create or replace trigger trade_features_touch before insert or update on public.trade_features
  for each row execute function public.touch_updated_at();

alter table public.trade_features enable row level security;
drop policy if exists trade_features_owner on public.trade_features;
create policy trade_features_owner on public.trade_features for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.trade_features from anon;
grant select, insert, update, delete on public.trade_features to authenticated;
