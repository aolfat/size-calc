-- Step 1 of the journal (docs/journal-step-1-supabase.md): each signed-in user's settings and saved positions,
-- and their Tradier key in Vault. Row-level security on every table: a row is visible and writable only by its owner.

create table public.settings (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  key text not null check (key in (
    'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier',
    'stop_strategy', 'stop_percent', 'last_ticker', 'tradier_env', 'tradier_key_at'
  )),
  value text not null check (length(value) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

-- today's saved cards, until open trades come from imported fills; a delete sets deleted_at so it reaches other devices
create table public.saved_positions (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null check (length(id) between 1 and 64),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, id)
);

create index settings_user_updated on public.settings (user_id, updated_at);
create index saved_positions_user_updated on public.saved_positions (user_id, updated_at);

-- the server's clock stamps every write, so device clocks never decide which change is newer
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger settings_touch before insert or update on public.settings
  for each row execute function public.touch_updated_at();
create trigger saved_positions_touch before insert or update on public.saved_positions
  for each row execute function public.touch_updated_at();

alter table public.settings enable row level security;
alter table public.saved_positions enable row level security;

create policy settings_owner on public.settings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy saved_positions_owner on public.saved_positions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.settings, public.saved_positions from anon;
grant select, insert, update, delete on public.settings, public.saved_positions to authenticated;

-- Tradier key: one Vault secret per user, named by user id. The app never touches Vault directly, only these three
-- functions, which run as their owner with a fixed search path and act on the caller's own secret alone.

create function public.set_tradier_key(new_key text) returns void
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

create function public.get_tradier_key() returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  secret text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select d.decrypted_secret into secret from vault.decrypted_secrets d where d.name = 'tradier_key:' || uid::text;
  return coalesce(secret, '');
end $$;

create function public.clear_tradier_key() returns void
language sql security definer set search_path = '' as $$
  select public.set_tradier_key('');
$$;

revoke execute on function public.set_tradier_key(text), public.get_tradier_key(), public.clear_tradier_key() from public, anon;
grant execute on function public.set_tradier_key(text), public.get_tradier_key(), public.clear_tradier_key() to authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
