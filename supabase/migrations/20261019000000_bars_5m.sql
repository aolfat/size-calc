-- Journal step 2, slice 3's groundwork: 5-minute bars for the symbols you traded, one row per symbol and trading day,
-- saved as you go because Tradier only serves about 40 days of them. The trade page's charts and the for-and-against
-- numbers (MFE, MAE) read these. A day Tradier had nothing for (a holiday) is kept empty so it's never asked again.
-- Per user, like everything else: bars fetched with one person's Tradier key aren't shared.

create table if not exists public.bars_5m (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  symbol text not null check (length(symbol) between 1 and 32), -- Tradier's form: options without the padding spaces
  day date not null, -- New York trading day
  bars jsonb not null check (jsonb_typeof(bars) = 'array' and octet_length(bars::text) <= 100000), -- [["09:30", o, h, l, c, v], ...]
  saved_at timestamptz not null default now(),
  primary key (user_id, symbol, day)
);

alter table public.bars_5m enable row level security;

drop policy if exists bars_5m_owner on public.bars_5m;
create policy bars_5m_owner on public.bars_5m for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.bars_5m from anon;
grant select, insert, update, delete on public.bars_5m to authenticated;
