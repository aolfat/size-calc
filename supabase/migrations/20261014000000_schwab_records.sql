-- Journal step 2, raw capture (docs/journal-step-2.md): every Schwab order and TRADE transaction exactly as Schwab sent
-- it, account numbers masked, so history outlives Schwab's window (60 days of orders). Fills, trades and stats are
-- derived from these later; a parsing fix re-runs over everything kept. Row-level security like every table.

create table public.schwab_records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('order', 'transaction')),
  record_id text not null check (length(record_id) between 1 and 64),
  account text not null check (account ~ '^[0-9]{1,4}$'), -- last 4 digits only
  entered_at timestamptz, -- an order's enteredTime, a transaction's time
  data jsonb not null check (octet_length(data::text) <= 200000),
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, kind, record_id)
);

create index schwab_records_user_entered on public.schwab_records (user_id, entered_at);

-- an order's status changes (working, then filled or canceled): the latest copy wins, and the server stamps the time
create trigger schwab_records_touch before insert or update on public.schwab_records
  for each row execute function public.touch_updated_at();

alter table public.schwab_records enable row level security;

create policy schwab_records_owner on public.schwab_records for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.schwab_records from anon;
grant select, insert, update, delete on public.schwab_records to authenticated;
