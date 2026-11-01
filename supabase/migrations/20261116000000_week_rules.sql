-- Week rules (docs/journal.md, docs/journal-notebook.md): a week's (or month's) review sets a list of rules for the next
-- one instead of a single rule, each day of that week checks each rule kept or broke, and the next review asks Kept it?
-- on each and how they went.
-- period_reviews.rules_next: [{ id, text }], five at most (rule_next keeps the first one's text, for anything reading the
-- old column); rules_kept: rule id → yes | partly | no, on the review after the one that set them (rule_kept stays the
-- answer for a rule from before the list); rules_note: how they went.
-- journal_days.week_rules: rule id → kept | broke, that day's check-in on its week's rules.
-- The app reads these on their own queries, so before this push the rest of the journal works and a review keeps its one
-- rule. Then claude_journal_read and claude_journal_save take them too (docs/claude-access.md).

alter table public.period_reviews add column if not exists rules_next jsonb not null default '[]'
  check (jsonb_typeof(rules_next) = 'array' and jsonb_array_length(rules_next) <= 5 and octet_length(rules_next::text) <= 4000);
alter table public.period_reviews add column if not exists rules_kept jsonb not null default '{}'
  check (jsonb_typeof(rules_kept) = 'object' and octet_length(rules_kept::text) <= 2000);
alter table public.period_reviews add column if not exists rules_note text check (length(rules_note) <= 5000);
alter table public.journal_days add column if not exists week_rules jsonb not null default '{}'
  check (jsonb_typeof(week_rules) = 'object' and octet_length(week_rules::text) <= 2000);

-- claude_journal_read as before, with each day's check-ins on its week's rules and each review's rules list
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
        'week_rules', d.week_rules, 'reviewed_at', d.reviewed_at))
      from public.journal_days d where d.user_id = uid), '[]'),
    'library', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'name', i.name,
        'default_key', i.default_key, 'hidden', i.hidden, 'merged_into', i.merged_into, 'settings', i.settings))
      from public.library_items i where i.user_id = uid), '[]'),
    'periods', coalesce((select jsonb_agg(jsonb_build_object('unit', p.unit, 'period_key', p.period_key,
        'selection_grade', p.selection_grade, 'selection_note', p.selection_note, 'entry_grade', p.entry_grade, 'entry_note', p.entry_note,
        'exit_grade', p.exit_grade, 'exit_note', p.exit_note, 'risk_grade', p.risk_grade, 'risk_note', p.risk_note,
        'emotion_grade', p.emotion_grade, 'emotion_note', p.emotion_note, 'market_grade', p.market_grade, 'market_note', p.market_note,
        'prep_grade', p.prep_grade, 'prep_note', p.prep_note, 'consistency_grade', p.consistency_grade, 'consistency_note', p.consistency_note,
        'went_well', p.went_well, 'work_on', p.work_on, 'note', p.note, 'rule_next', p.rule_next, 'rule_kept', p.rule_kept,
        'rules_next', p.rules_next, 'rules_kept', p.rules_kept, 'rules_note', p.rules_note, 'reviewed_at', p.reviewed_at))
      from public.period_reviews p where p.user_id = uid), '[]'),
    'order_plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'account', p.account, 'symbol', p.symbol,
        'side', p.side, 'order_ids', p.order_ids, 'sent_at', p.sent_at, 'setups', p.setups, 'tactics', p.tactics,
        'plan', p.plan, 'trade_key', p.trade_key) order by p.sent_at)
      from public.order_plans p where p.user_id = uid), '[]')
  );
end $$;

-- claude_journal_save as before, plus a day's week_rules ({ rule id: kept | broke | null }, merged one rule at a time like
-- rules) and a review's rules_next (the whole list), rules_kept ({ rule id: yes | partly | no | null }, merged the same
-- way) and rules_note
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
    if exists (select 1 from jsonb_object_keys(f) k where k not in ('grade', 'rules', 'week_rules', 'went_well', 'work_on', 'note', 'focus_next', 'focus_kept', 'reviewed_at')) then
      raise exception 'day review fields: grade, rules, week_rules, went_well, work_on, note, focus_next, focus_kept, reviewed_at';
    end if;
    if f ? 'week_rules' and (jsonb_typeof(f->'week_rules') is distinct from 'object'
        or exists (select 1 from jsonb_each(f->'week_rules') e where e.value not in ('"kept"'::jsonb, '"broke"'::jsonb, 'null'::jsonb))) then
      raise exception 'week_rules: { rule id: kept, broke or null }';
    end if;
    if f ? 'rules' and (jsonb_typeof(f->'rules') is distinct from 'object'
        or exists (select 1 from jsonb_each(f->'rules') e where e.value not in ('"kept"'::jsonb, '"broke"'::jsonb, 'null'::jsonb))) then
      raise exception 'rules: { rule key: kept, broke or null }';
    end if;
    insert into public.journal_days (user_id, day) values (uid, (r->>'day')::date) on conflict (user_id, day) do nothing;
    update public.journal_days d set
      grade = case when f ? 'grade' then f->>'grade' else d.grade end,
      rules = case when f ? 'rules' then jsonb_strip_nulls(coalesce(d.rules, '{}') || (f->'rules')) else d.rules end,
      week_rules = case when f ? 'week_rules' then jsonb_strip_nulls(coalesce(d.week_rules, '{}') || (f->'week_rules')) else d.week_rules end,
      went_well = case when f ? 'went_well' then f->>'went_well' else d.went_well end,
      work_on = case when f ? 'work_on' then f->>'work_on' else d.work_on end,
      note = case when f ? 'note' then f->>'note' else d.note end,
      focus_next = case when f ? 'focus_next' then f->>'focus_next' else d.focus_next end,
      focus_kept = case when f ? 'focus_kept' then f->>'focus_kept' else d.focus_kept end,
      reviewed_at = case when f ? 'reviewed_at' then (f->>'reviewed_at')::timestamptz else d.reviewed_at end
      where d.user_id = uid and d.day = (r->>'day')::date;
    n := n + 1;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_changes->'periods', '[]')) loop
    f := coalesce(r->'fields', '{}');
    if exists (select 1 from jsonb_object_keys(f) k where k not in ('selection_grade', 'selection_note', 'entry_grade', 'entry_note',
        'exit_grade', 'exit_note', 'risk_grade', 'risk_note', 'emotion_grade', 'emotion_note', 'market_grade', 'market_note',
        'prep_grade', 'prep_note', 'consistency_grade', 'consistency_note', 'went_well', 'work_on', 'note', 'rule_next',
        'rule_kept', 'rules_next', 'rules_kept', 'rules_note', 'reviewed_at')) then
      raise exception 'period review fields: each part''s grade and note, went_well, work_on, note, rule_next, rule_kept, rules_next, rules_kept, rules_note, reviewed_at';
    end if;
    if f ? 'rules_kept' and (jsonb_typeof(f->'rules_kept') is distinct from 'object'
        or exists (select 1 from jsonb_each(f->'rules_kept') e where e.value not in ('"yes"'::jsonb, '"partly"'::jsonb, '"no"'::jsonb, 'null'::jsonb))) then
      raise exception 'rules_kept: { rule id: yes, partly, no or null }';
    end if;
    insert into public.period_reviews (user_id, unit, period_key) values (uid, r->>'unit', r->>'key') on conflict (user_id, unit, period_key) do nothing;
    update public.period_reviews p set
      selection_grade = case when f ? 'selection_grade' then f->>'selection_grade' else p.selection_grade end,
      selection_note = case when f ? 'selection_note' then f->>'selection_note' else p.selection_note end,
      entry_grade = case when f ? 'entry_grade' then f->>'entry_grade' else p.entry_grade end,
      entry_note = case when f ? 'entry_note' then f->>'entry_note' else p.entry_note end,
      exit_grade = case when f ? 'exit_grade' then f->>'exit_grade' else p.exit_grade end,
      exit_note = case when f ? 'exit_note' then f->>'exit_note' else p.exit_note end,
      risk_grade = case when f ? 'risk_grade' then f->>'risk_grade' else p.risk_grade end,
      risk_note = case when f ? 'risk_note' then f->>'risk_note' else p.risk_note end,
      emotion_grade = case when f ? 'emotion_grade' then f->>'emotion_grade' else p.emotion_grade end,
      emotion_note = case when f ? 'emotion_note' then f->>'emotion_note' else p.emotion_note end,
      market_grade = case when f ? 'market_grade' then f->>'market_grade' else p.market_grade end,
      market_note = case when f ? 'market_note' then f->>'market_note' else p.market_note end,
      prep_grade = case when f ? 'prep_grade' then f->>'prep_grade' else p.prep_grade end,
      prep_note = case when f ? 'prep_note' then f->>'prep_note' else p.prep_note end,
      consistency_grade = case when f ? 'consistency_grade' then f->>'consistency_grade' else p.consistency_grade end,
      consistency_note = case when f ? 'consistency_note' then f->>'consistency_note' else p.consistency_note end,
      went_well = case when f ? 'went_well' then f->>'went_well' else p.went_well end,
      work_on = case when f ? 'work_on' then f->>'work_on' else p.work_on end,
      note = case when f ? 'note' then f->>'note' else p.note end,
      rule_next = case when f ? 'rule_next' then f->>'rule_next' else p.rule_next end,
      rule_kept = case when f ? 'rule_kept' then f->>'rule_kept' else p.rule_kept end,
      rules_next = case when f ? 'rules_next' then coalesce(f->'rules_next', '[]') else p.rules_next end,
      rules_kept = case when f ? 'rules_kept' then jsonb_strip_nulls(coalesce(p.rules_kept, '{}') || (f->'rules_kept')) else p.rules_kept end,
      rules_note = case when f ? 'rules_note' then f->>'rules_note' else p.rules_note end,
      reviewed_at = case when f ? 'reviewed_at' then (f->>'reviewed_at')::timestamptz else p.reviewed_at end
      where p.user_id = uid and p.unit = r->>'unit' and p.period_key = r->>'key';
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n);
end $$;

-- the same rights as before: a key in place of a sign-in (tests/rls.test.mjs)
revoke execute on function public.claude_journal_read(text), public.claude_journal_save(text, jsonb) from public;
grant execute on function public.claude_journal_read(text), public.claude_journal_save(text, jsonb) to anon, authenticated;
