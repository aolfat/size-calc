-- Journal step 2: your own word on a trade. Trades aren't stored (they're rebuilt from the kept fills every read), so this
-- points at one by its trade key: account|symbol|direction|open time, stable across imports. It holds the stop you set
-- (an option's mental stop, or a correction to Schwab's) and whether you've hidden the trade (imported but doesn't
-- belong; its fills stay kept, so the next import can't bring it back). Step 3's grades and notes join this row.

create table public.trade_reviews (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trade_key text not null check (length(trade_key) between 1 and 200),
  stop numeric check (stop is null or stop > 0),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, trade_key)
);

create trigger trade_reviews_touch before insert or update on public.trade_reviews
  for each row execute function public.touch_updated_at();

alter table public.trade_reviews enable row level security;

create policy trade_reviews_owner on public.trade_reviews for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.trade_reviews from anon;
grant select, insert, update, delete on public.trade_reviews to authenticated;
