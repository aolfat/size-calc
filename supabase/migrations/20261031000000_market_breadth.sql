-- Market breadth (docs/journal-features.md): the % of US common stocks over their 5 / 20 / 50 / 100 / 200-day averages
-- at each day's close, the app's own take on Barchart's $MMFD / $MMTW / $MMFI / $MMOH / $MMTH, counted in the browser
-- from Massive's grouped daily bars and read by the trade features. One row per (user, universe, New York day):
-- counts = { "5": [above, counted], "20": [...], ... } (an average left out when there weren't enough sessions before),
-- or { "closed": true } for a weekday the market was shut.

create table if not exists public.market_breadth (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  universe text not null default 'us_common' check (length(universe) between 1 and 40),
  day date not null,
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object' and octet_length(counts::text) <= 2000),
  source text not null default 'massive' check (length(source) between 1 and 40),
  updated_at timestamptz not null default now(),
  primary key (user_id, universe, day)
);

create or replace trigger market_breadth_touch before insert or update on public.market_breadth
  for each row execute function public.touch_updated_at();

alter table public.market_breadth enable row level security;
drop policy if exists market_breadth_owner on public.market_breadth;
create policy market_breadth_owner on public.market_breadth for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.market_breadth from anon;
grant select, insert, update, delete on public.market_breadth to authenticated;
