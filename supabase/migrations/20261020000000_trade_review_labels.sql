-- Journal step 3, slice 1 (docs/journal-step-3.md): reviewing a trade. Its grades and note go on its trade_reviews row;
-- its labels (sector, setups, tactic, tags, mistakes) are their own rows; the market is set per trading day; and the
-- choices you add, rename, hide or merge are yours. Labels point to the trade's key like trade_reviews does, so
-- re-imports and fixes to the math never detach them. The defaults live in the app's code (src/core/journal-labels.js).

alter table public.trade_reviews add column if not exists setup_grade text check (setup_grade in ('A++', 'A', 'B', 'C', 'D', 'F'));
alter table public.trade_reviews add column if not exists plan_followed text check (plan_followed in ('yes', 'partly', 'no'));
alter table public.trade_reviews add column if not exists note text check (length(note) <= 5000);
alter table public.trade_reviews add column if not exists market text check (length(market) between 1 and 80); -- this trade only, over the day's
alter table public.trade_reviews add column if not exists reviewed_at timestamptz; -- set while the required fields are all there

create table if not exists public.trade_labels (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  trade_key text not null check (length(trade_key) between 1 and 200),
  kind text not null check (kind in ('sector', 'setup', 'tactic', 'tag', 'mistake')),
  value text not null check (length(value) between 1 and 120), -- an item key: 'sma50+bounce', 'pivot30', 'mine:<uuid>'
  set_by text not null default 'you' check (set_by in ('you', 'app')),
  reason text check (length(reason) <= 500), -- why the app guessed it
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now(),
  primary key (user_id, trade_key, kind, value)
);

create table if not exists public.journal_days (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null, -- the New York trading day
  market text check (length(market) between 1 and 80),
  note text check (length(note) <= 5000),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create or replace trigger journal_days_touch before insert or update on public.journal_days
  for each row execute function public.touch_updated_at();

create table if not exists public.library_items (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('market', 'sector', 'level', 'action', 'pattern', 'tactic', 'tag', 'mistake')),
  name text not null check (length(name) between 1 and 80),
  default_key text check (length(default_key) between 1 and 40), -- set when the row renames or hides one of the defaults
  hidden boolean not null default false,
  merged_into text check (length(merged_into) between 1 and 120), -- an item key: labels on this one count as that one
  settings jsonb not null default '{}' check (octet_length(settings::text) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create or replace trigger library_items_touch before insert or update on public.library_items
  for each row execute function public.touch_updated_at();

alter table public.trade_labels enable row level security;
alter table public.journal_days enable row level security;
alter table public.library_items enable row level security;

drop policy if exists trade_labels_owner on public.trade_labels;
create policy trade_labels_owner on public.trade_labels for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists journal_days_owner on public.journal_days;
create policy journal_days_owner on public.journal_days for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists library_items_owner on public.library_items;
create policy library_items_owner on public.library_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.trade_labels, public.journal_days, public.library_items from anon;
grant select, insert, update, delete on public.trade_labels, public.journal_days, public.library_items to authenticated;
