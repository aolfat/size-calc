-- Claude access (docs/claude-access.md): a key made in Settings lets a Claude Code session read your journal and save
-- trade reviews, and nothing else. The browser makes the key and keeps only its SHA-256 here; the key is shown once, and
-- deleting its row (Revoke) stops it at once. The key stands in for a sign-in on two functions only: claude_journal_read
-- (the records, shaped trades, reviews, labels, each day's market and your library) and claude_journal_save (review
-- fields, labels, a day's market, your own library items). Settings, the Tradier key in Vault and anything else stay
-- out of reach: each function acts on the key owner's rows alone, in the tables it names.

create table if not exists public.claude_keys (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 hex of the key
  label text not null default 'Claude' check (length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (user_id, id)
);

alter table public.claude_keys enable row level security;
drop policy if exists claude_keys_owner on public.claude_keys;
create policy claude_keys_owner on public.claude_keys for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.claude_keys from anon;
grant select, insert, update, delete on public.claude_keys to authenticated;

-- the key's owner, its use stamped; anything else is refused. Called only by the two functions below.
create or replace function public.claude_key_user(p_key text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid;
begin
  if p_key is null or length(p_key) not between 32 and 200 then raise exception 'not a Claude key' using errcode = '28000'; end if;
  update public.claude_keys k set last_used_at = now()
    where k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
    returning k.user_id into uid;
  if uid is null then raise exception 'not a Claude key' using errcode = '28000'; end if;
  return uid;
end $$;

create or replace function public.claude_journal_read(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.claude_key_user(p_key);
begin
  return jsonb_build_object(
    'records', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'record_id', r.record_id, 'account', r.account,
        'entered_at', r.entered_at, 'data', r.data) order by r.entered_at desc nulls last)
      from (select * from public.schwab_records s where s.user_id = uid order by s.entered_at desc nulls last limit 5000) r), '[]'),
    'trades', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'account', t.account, 'fill_ids', t.fill_ids,
        'created_at', t.created_at) order by t.created_at)
      from public.trades t where t.user_id = uid), '[]'),
    'reviews', coalesce((select jsonb_agg(jsonb_build_object('trade_key', v.trade_key, 'stop', v.stop, 'deleted', v.deleted,
        'setup_grade', v.setup_grade, 'plan_followed', v.plan_followed, 'note', v.note, 'entry_note', v.entry_note,
        'market', v.market, 'reviewed_at', v.reviewed_at, 'weekly_at', v.weekly_at))
      from public.trade_reviews v where v.user_id = uid), '[]'),
    'labels', coalesce((select jsonb_agg(jsonb_build_object('trade_key', l.trade_key, 'kind', l.kind, 'value', l.value,
        'set_by', l.set_by, 'links', l.links))
      from public.trade_labels l where l.user_id = uid), '[]'),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'market', d.market))
      from public.journal_days d where d.user_id = uid and d.market is not null), '[]'),
    'library', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'name', i.name,
        'default_key', i.default_key, 'hidden', i.hidden, 'merged_into', i.merged_into, 'settings', i.settings))
      from public.library_items i where i.user_id = uid), '[]')
  );
end $$;

-- p_changes: { library: [{ id, kind, name, settings }], reviews: [{ trade_key, fields: { stop, setup_grade,
-- plan_followed, note, entry_note, market, reviewed_at } }] (only the fields sent change; null clears one),
-- labels_remove / labels_add: [{ trade_key, kind, value }], days: [{ day, market }] }, all in one transaction.
create or replace function public.claude_journal_save(p_key text, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := public.claude_key_user(p_key);
  r jsonb;
  f jsonb;
  n int := 0;
begin
  if jsonb_typeof(p_changes) is distinct from 'object' or octet_length(p_changes::text) > 100000 then
    raise exception 'changes: one object, 100 KB at most';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'library', '[]')) loop
    insert into public.library_items (user_id, id, kind, name, settings)
      values (uid, (r->>'id')::uuid, r->>'kind', r->>'name', coalesce(r->'settings', '{}'))
      on conflict (user_id, id) do update set name = excluded.name, settings = excluded.settings;
    n := n + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'reviews', '[]')) loop
    f := coalesce(r->'fields', '{}');
    if exists (select 1 from jsonb_object_keys(f) k where k not in ('stop', 'setup_grade', 'plan_followed', 'note', 'entry_note', 'market', 'reviewed_at')) then
      raise exception 'review fields: stop, setup_grade, plan_followed, note, entry_note, market, reviewed_at';
    end if;
    if length(f->>'entry_note') > 5000 then raise exception 'entry note: 5000 characters at most'; end if;
    insert into public.trade_reviews (user_id, trade_key) values (uid, r->>'trade_key') on conflict (user_id, trade_key) do nothing;
    update public.trade_reviews v set
      stop = case when f ? 'stop' then (f->>'stop')::numeric else v.stop end,
      setup_grade = case when f ? 'setup_grade' then f->>'setup_grade' else v.setup_grade end,
      plan_followed = case when f ? 'plan_followed' then f->>'plan_followed' else v.plan_followed end,
      note = case when f ? 'note' then f->>'note' else v.note end,
      entry_note = case when f ? 'entry_note' then f->>'entry_note' else v.entry_note end,
      market = case when f ? 'market' then f->>'market' else v.market end,
      reviewed_at = case when f ? 'reviewed_at' then (f->>'reviewed_at')::timestamptz else v.reviewed_at end
      where v.user_id = uid and v.trade_key = r->>'trade_key';
    n := n + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'labels_remove', '[]')) loop
    delete from public.trade_labels l where l.user_id = uid and l.trade_key = r->>'trade_key' and l.kind = r->>'kind' and l.value = r->>'value';
    n := n + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'labels_add', '[]')) loop
    insert into public.trade_labels (user_id, trade_key, kind, value, set_by) values (uid, r->>'trade_key', r->>'kind', r->>'value', 'you')
      on conflict (user_id, trade_key, kind, value) do nothing;
    n := n + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'days', '[]')) loop
    insert into public.journal_days (user_id, day, market) values (uid, (r->>'day')::date, r->>'market')
      on conflict (user_id, day) do update set market = excluded.market;
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end $$;

-- the key check is internal; the two journal functions take a key in place of a sign-in, so they're open to anon
-- (tests/rls.test.mjs allows that for these two alone, and checks each starts by checking the key)
revoke execute on function public.claude_key_user(text) from public, anon, authenticated;
revoke execute on function public.claude_journal_read(text), public.claude_journal_save(text, jsonb) from public;
grant execute on function public.claude_journal_read(text), public.claude_journal_save(text, jsonb) to anon, authenticated;
