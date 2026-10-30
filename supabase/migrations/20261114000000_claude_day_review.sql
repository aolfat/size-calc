-- Claude access to the day's review (docs/claude-access.md, docs/journal-notebook.md): a Claude session can save the
-- notebook's post-market half the way the page does: the day grade, each rule kept or broke, what went well, what to
-- work on, more notes, tomorrow's focus and whether the last one was kept, and reviewed_at. The premarket plan (the
-- check-in, the plan, the focus list) and the missed trades stay out of reach. claude_journal_read returns every day
-- row with those fields, so the script sees where a day's review stands.

-- claude_journal_read as before, with each day's review
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
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', d.day, 'market', d.market, 'grade', d.grade, 'rules', d.rules,
        'went_well', d.went_well, 'work_on', d.work_on, 'note', d.note, 'focus_next', d.focus_next, 'focus_kept', d.focus_kept,
        'reviewed_at', d.reviewed_at))
      from public.journal_days d where d.user_id = uid), '[]'),
    'library', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'name', i.name,
        'default_key', i.default_key, 'hidden', i.hidden, 'merged_into', i.merged_into, 'settings', i.settings))
      from public.library_items i where i.user_id = uid), '[]'),
    'order_plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'account', p.account, 'symbol', p.symbol,
        'side', p.side, 'order_ids', p.order_ids, 'sent_at', p.sent_at, 'setups', p.setups, 'tactics', p.tactics,
        'plan', p.plan, 'trade_key', p.trade_key) order by p.sent_at)
      from public.order_plans p where p.user_id = uid), '[]')
  );
end $$;

-- claude_journal_save as before, plus notebook: [{ day, fields: { grade, rules, went_well, work_on, note, focus_next,
-- focus_kept, reviewed_at } }] (only the fields sent change; rules merge one rule at a time, a null answer clears it)
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
  for r in select * from jsonb_array_elements(coalesce(p_changes->'notebook', '[]')) loop
    f := coalesce(r->'fields', '{}');
    if exists (select 1 from jsonb_object_keys(f) k where k not in ('grade', 'rules', 'went_well', 'work_on', 'note', 'focus_next', 'focus_kept', 'reviewed_at')) then
      raise exception 'day review fields: grade, rules, went_well, work_on, note, focus_next, focus_kept, reviewed_at';
    end if;
    if f ? 'rules' and (jsonb_typeof(f->'rules') is distinct from 'object'
        or exists (select 1 from jsonb_each(f->'rules') e where e.value not in ('"kept"'::jsonb, '"broke"'::jsonb, 'null'::jsonb))) then
      raise exception 'rules: { rule key: kept, broke or null }';
    end if;
    insert into public.journal_days (user_id, day) values (uid, (r->>'day')::date) on conflict (user_id, day) do nothing;
    update public.journal_days d set
      grade = case when f ? 'grade' then f->>'grade' else d.grade end,
      rules = case when f ? 'rules' then jsonb_strip_nulls(coalesce(d.rules, '{}') || (f->'rules')) else d.rules end,
      went_well = case when f ? 'went_well' then f->>'went_well' else d.went_well end,
      work_on = case when f ? 'work_on' then f->>'work_on' else d.work_on end,
      note = case when f ? 'note' then f->>'note' else d.note end,
      focus_next = case when f ? 'focus_next' then f->>'focus_next' else d.focus_next end,
      focus_kept = case when f ? 'focus_kept' then f->>'focus_kept' else d.focus_kept end,
      reviewed_at = case when f ? 'reviewed_at' then (f->>'reviewed_at')::timestamptz else d.reviewed_at end
      where d.user_id = uid and d.day = (r->>'day')::date;
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end $$;

-- the same rights as before: a key in place of a sign-in (tests/rls.test.mjs)
revoke execute on function public.claude_journal_read(text), public.claude_journal_save(text, jsonb) from public;
grant execute on function public.claude_journal_read(text), public.claude_journal_save(text, jsonb) to anon, authenticated;
