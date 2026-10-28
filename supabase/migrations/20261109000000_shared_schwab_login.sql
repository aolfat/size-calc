-- One Schwab login for every device (docs/schwab.md): Schwab keeps one login per app at a time, so a phone logging in
-- ended the desktop's. The signed-in user's login is one Vault secret, named by user id like the Tradier key, and only
-- these functions touch it. Each write stamps schwab_login_at so the user's other devices fetch it.

-- CLOUD_KEYS in src/services/cloud.js, plus the stamps the Vault functions write; a test keeps them in step
alter table public.settings drop constraint if exists settings_key_check;
alter table public.settings add constraint settings_key_check check (key in (
  'calc_account', 'calc_risk', 'calc_allocation', 'risk_usd_presets', 'atr_multiplier', 'stop_strategy', 'stop_percent',
  'last_ticker', 'tradier_env', 'tradier_key_at', 'schwab_login_at', 'schwab_proxy', 'journal_fees', 'journal_deck_pnl',
  'journal_review_from'
));

create or replace function public.get_schwab_login() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  secret text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  select d.decrypted_secret into secret from vault.decrypted_secrets d where d.name = 'schwab_login:' || uid::text;
  return nullif(secret, '')::jsonb;
end $$;

-- p_login: { proxy, connectionId, access, accessExp, refresh, refreshExp }, or null to clear. Compare-and-swap, so an
-- older login never overwrites a newer one: it writes when nothing is kept, when the kept login's refresh token is
-- p_expect (renewing that login, or clearing one Schwab refused), or, with no p_expect, when p_login is a different
-- login that ends later (a new login). Returns the login kept afterwards, so a device that lost learns the winner.
create or replace function public.set_schwab_login(p_login jsonb, p_expect text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  secret_name text;
  secret_id uuid;
  kept jsonb;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if p_login is not null and (jsonb_typeof(p_login) is distinct from 'object' or octet_length(p_login::text) > 8000
      or jsonb_typeof(p_login->'refresh') is distinct from 'string' or jsonb_typeof(p_login->'connectionId') is distinct from 'string'
      or jsonb_typeof(p_login->'refreshExp') is distinct from 'number') then
    raise exception 'not a Schwab login';
  end if;
  secret_name := 'schwab_login:' || uid::text;
  -- one write at a time per user, so two devices can't both pass the check below
  perform pg_advisory_xact_lock(hashtext(secret_name));
  select s.id into secret_id from vault.secrets s where s.name = secret_name;
  select nullif(d.decrypted_secret, '')::jsonb into kept from vault.decrypted_secrets d where d.id = secret_id;
  if not (kept is null
      or (p_expect is not null and kept->>'refresh' = p_expect)
      or (p_expect is null and p_login is not null and p_login->>'connectionId' is distinct from kept->>'connectionId'
        and (p_login->>'refreshExp')::numeric > coalesce((kept->>'refreshExp')::numeric, 0))) then
    return kept;
  end if;
  if p_login is null then
    if secret_id is not null then delete from vault.secrets s where s.id = secret_id; end if;
  elsif secret_id is null then
    perform vault.create_secret(p_login::text, secret_name);
  else
    perform vault.update_secret(secret_id, p_login::text);
  end if;
  insert into public.settings (user_id, key, value) values (uid, 'schwab_login_at', now()::text)
    on conflict (user_id, key) do update set value = excluded.value;
  return p_login;
end $$;

-- Disconnect on every device: whatever is kept goes, and the stamp tells the other devices to drop their copies
create or replace function public.clear_schwab_login() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in'; end if;
  perform pg_advisory_xact_lock(hashtext('schwab_login:' || uid::text));
  delete from vault.secrets s where s.name = 'schwab_login:' || uid::text;
  insert into public.settings (user_id, key, value) values (uid, 'schwab_login_at', now()::text)
    on conflict (user_id, key) do update set value = excluded.value;
end $$;

revoke execute on function public.get_schwab_login(), public.set_schwab_login(jsonb, text), public.clear_schwab_login() from public, anon;
grant execute on function public.get_schwab_login(), public.set_schwab_login(jsonb, text), public.clear_schwab_login() to authenticated;
