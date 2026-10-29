-- Disconnect everywhere stuck only until another device renewed: set_schwab_login took any write when nothing was
-- kept, so a device that refreshed its token before its next pull (p_expect set) put the ended login back in the account.
-- Now a renewal needs the login it renews to still be kept; a first login (no p_expect) writes as before.

-- p_login: { proxy, connectionId, access, accessExp, refresh, refreshExp }, or null to clear. Compare-and-swap, so an
-- older login never overwrites a newer one: it writes when nothing is kept and there's no p_expect (a first login),
-- when the kept login's refresh token is p_expect (renewing that login, or clearing one Schwab refused), or, with no
-- p_expect, when p_login is a different login that ends later (a new login). A renewal (p_expect) of a login that's no
-- longer kept is refused: it was ended on every device, and a device renewing before its next pull must not bring it
-- back. Returns the login kept afterwards, so a device that lost learns the winner.
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
  if not ((kept is null and p_expect is null)
      or (p_expect is not null and kept is not null and kept->>'refresh' = p_expect) -- false, not null, when nothing is kept: if not (null) skips the return
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
