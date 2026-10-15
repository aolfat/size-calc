-- Journal trades you shaped (docs/journal-step-2.md): a trade the app's flat-to-flat grouping split, merged into one,
-- or a spread's legs as one trade. A row is the trade's identity and the fills it claims, by their Schwab ids; P&L, R
-- and the rest are computed in the browser from those fills, so a calculation fix still reaches every trade. Trades
-- nobody touched have no row; a row with one trade keeps it on its own (a multi-leg order's leg split off). Separate =
-- delete the row. trade_reviews keeps your stop and delete on a shaped trade under 'trade:<id>'. This replaces
-- trade_reviews.group_key (20261017000000), which the app converts to rows on load; the column goes in the squash.

create table public.trades (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  account text not null check (account ~ '^[0-9]{1,4}$'), -- last 4 digits only
  fill_ids text[] not null check (cardinality(fill_ids) between 1 and 2000 and octet_length(fill_ids::text) <= 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create trigger trades_touch before insert or update on public.trades
  for each row execute function public.touch_updated_at();

alter table public.trades enable row level security;

create policy trades_owner on public.trades for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.trades from anon;
grant select, insert, update, delete on public.trades to authenticated;
