-- Order plans (docs/schwab.md, docs/journal.md): what the Trade at Schwab sheet saves with an order once it's sent. The
-- setups and entry tactics picked (library item keys), and in plan the numbers to analyze later: the shares, the planned
-- risk and the Schwab account's value when it went (risk as a % of the account), and how the stop was set (LOD/HOD with
-- the ATR or percent adjustment, a custom stop or the opening range, the level, the 5m ATR). order_ids is every id the
-- entry has had (Change limit adds the new one); empty when Schwab's answer was lost. trade_key is set once the journal
-- has put the plan's labels on its trade, so they go on once and your changes after stay.
-- claude_journal_read returns the plans too, so a Claude session can analyze them.

create table if not exists public.order_plans (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  account text not null check (account ~ '^[0-9]{1,4}$'), -- last 4 digits only
  symbol text not null check (length(symbol) between 1 and 40),
  side text not null check (side in ('long', 'short')),
  order_ids text[] not null default '{}' check (cardinality(order_ids) <= 50 and octet_length(order_ids::text) <= 2500),
  sent_at timestamptz not null,
  setups text[] not null default '{}' check (cardinality(setups) <= 10 and octet_length(setups::text) <= 1500),
  tactics text[] not null default '{}' check (cardinality(tactics) <= 10 and octet_length(tactics::text) <= 1500),
  plan jsonb not null default '{}' check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 8000),
  trade_key text check (length(trade_key) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists order_plans_order_ids on public.order_plans using gin (order_ids);

create or replace trigger order_plans_touch before insert or update on public.order_plans
  for each row execute function public.touch_updated_at();

alter table public.order_plans enable row level security;
drop policy if exists order_plans_owner on public.order_plans;
create policy order_plans_owner on public.order_plans for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.order_plans from anon;
grant select, insert, update, delete on public.order_plans to authenticated;

-- claude_journal_read as before, with the order plans
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
      from public.library_items i where i.user_id = uid), '[]'),
    'order_plans', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'account', p.account, 'symbol', p.symbol,
        'side', p.side, 'order_ids', p.order_ids, 'sent_at', p.sent_at, 'setups', p.setups, 'tactics', p.tactics,
        'plan', p.plan, 'trade_key', p.trade_key) order by p.sent_at)
      from public.order_plans p where p.user_id = uid), '[]')
  );
end $$;
