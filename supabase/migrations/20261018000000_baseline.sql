-- The whole schema, one file (docs/journal-step-2.md, slice 6: the eight migrations of steps 1 and 2 squashed). Safe to
-- run on a new database and on one that already has some of it: tables and indexes are created if missing, functions
-- and triggers replaced, policies dropped and made again, and the last section brings an older database up to date.
-- Row-level security on every table: a row is visible and writable only by its owner (tests/rls.test.mjs checks it).

-- the server's clock stamps every write, so device clocks never decide which change is newer
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- settings: the account's synced settings, one row per key (docs/journal-step-1-supabase.md) ----------

create table if not exists public.settings (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null,
  value text not null check (length(value) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- CLOUD_KEYS in src/services/cloud.js, plus tradier_key_at (stamped by set_tradier_key); a test keeps them in step
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent',
  'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_proxy', 'journal_fees'
));

create index if not exists settings_user_updated on public.settings (user_id, updated_at);
create or replace trigger settings_touch before insert or update on public.settings
  for each row execute function public.touch_updated_at();

-- ---------- schwab_records: every Schwab order and TRADE transaction as Schwab sent it, account numbers masked ----------
-- History outlives Schwab's window (60 days of orders); fills and trades are derived from these, so a parsing fix
-- re-runs over everything kept. fingerprint = SHA-256 hex of the JSON with keys sorted, so an import sends only changes.

create table if not exists public.schwab_records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('order', 'transaction')),
  record_id text not null check (length(record_id) between 1 and 64),
  account text not null check (account ~ '^[0-9]{1,4}$'), -- last 4 digits only
  entered_at timestamptz, -- an order's enteredTime, a transaction's time
  data jsonb not null check (octet_length(data::text) <= 200000),
  fingerprint text check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$'),
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, record_id)
);

create index if not exists schwab_records_user_entered on public.schwab_records (user_id, entered_at);
-- an order's status changes (working, then filled or canceled): the latest copy wins, and the server stamps the time
create or replace trigger schwab_records_touch before insert or update on public.schwab_records
  for each row execute function public.touch_updated_at();

-- ---------- trade_reviews: your word on a trade, by its key (account|symbol|direction|open time, or trade:<id>) ----------
-- The stop you set (an option's mental stop, or a correction to Schwab's) and whether you deleted the trade (imported
-- but doesn't belong; its records stay kept, so an import can't bring it back). Step 3's grades and notes join this row.

create table if not exists public.trade_reviews (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trade_key text not null check (length(trade_key) between 1 and 200),
  stop numeric check (stop is null or stop > 0),
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, trade_key)
);

create or replace trigger trade_reviews_touch before insert or update on public.trade_reviews
  for each row execute function public.touch_updated_at();

-- ---------- trades: the trades you shaped, each the fills it claims by their Schwab ids ----------
-- Two or more trades on one symbol merged into one, or option legs as one spread; a row with one trade keeps it on its
-- own (a multi-leg order's leg split off). Numbers are computed in the browser from the fills, so a calculation fix
-- still reaches every trade. Separate = delete the row; your stop and delete on it live in trade_reviews as trade:<id>.

create table if not exists public.trades (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  account text not null check (account ~ '^[0-9]{1,4}$'), -- last 4 digits only
  fill_ids text[] not null check (cardinality(fill_ids) between 1 and 2000 and octet_length(fill_ids::text) <= 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create or replace trigger trades_touch before insert or update on public.trades
  for each row execute function public.touch_updated_at();

-- ---------- row-level security: every table, its owner only, nothing for anon ----------

alter table public.settings enable row level security;
alter table public.schwab_records enable row level security;
alter table public.trade_reviews enable row level security;
alter table public.trades enable row level security;

drop policy if exists settings_owner on public.settings;
create policy settings_owner on public.settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists schwab_records_owner on public.schwab_records;
create policy schwab_records_owner on public.schwab_records for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists trade_reviews_owner on public.trade_reviews;
create policy trade_reviews_owner on public.trade_reviews for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists trades_owner on public.trades;
create policy trades_owner on public.trades for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.settings, public.schwab_records, public.trade_reviews, public.trades from anon;
grant select, insert, update, delete on public.settings, public.schwab_records, public.trade_reviews, public.trades to authenticated;

-- ---------- the Tradier key: one Vault secret per user, named by user id ----------
-- The app never touches Vault directly, only these three functions, which run as their owner with a fixed search path
-- and act on the caller's own secret alone.

create or replace function public.set_tradier_key(new_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  secret_name text;
  secret_id uuid;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if length(coalesce(new_key, '')) > 500 then raise exception 'key too long'; end if;
  secret_name := 'tradier_key:' || uid::text;
  select s.id into secret_id from vault.secrets s where s.name = secret_name;
  if coalesce(new_key, '') = '' then
    if secret_id is not null then delete from vault.secrets s where s.id = secret_id; end if;
  elsif secret_id is null then
    perform vault.create_secret(new_key, secret_name);
  else
    perform vault.update_secret(secret_id, new_key);
  end if;
  -- tells the user's other devices to fetch the new key
  insert into public.settings (user_id, key, value) values (uid, 'tradier_key_at', now()::text)
    on conflict (user_id, key) do update set value = excluded.value;
end $$;

create or replace function public.get_tradier_key() returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  secret text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select d.decrypted_secret into secret from vault.decrypted_secrets d where d.name = 'tradier_key:' || uid::text;
  return coalesce(secret, '');
end $$;

create or replace function public.clear_tradier_key() returns void
language sql security definer set search_path = '' as $$
  select public.set_tradier_key('');
$$;

revoke execute on function public.set_tradier_key(text), public.get_tradier_key(), public.clear_tradier_key() from public, anon;
grant execute on function public.set_tradier_key(text), public.get_tradier_key(), public.clear_tradier_key() to authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;

-- ---------- an older database brought up to date (a no-op on a new one) ----------

-- retired saved position cards (Positions shows live Schwab positions)
drop table if exists public.saved_positions;
-- delta imports' fingerprint, on a schwab_records made before it
alter table public.schwab_records add column if not exists fingerprint text
  check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$');
-- the delete mark was first named hidden
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trade_reviews' and column_name = 'hidden') then
    alter table public.trade_reviews rename column hidden to deleted;
  end if;
end $$;
-- spreads were first combined through each leg's group_key; the trades table replaces it
alter table public.trade_reviews drop column if exists group_key;
