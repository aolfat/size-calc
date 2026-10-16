-- Journal step 3, slice 1 (docs/journal-step-3.md): My setups, and links on a trade's tags.
-- A setup is saved once (an action at one or more levels, or a pattern, kept in settings) and picked from then on, so
-- library_items now holds setups too. A tag on a trade can carry links: the Option flow tag holds the Unusual Whales or
-- Bullflow pages for that trade's flow (https only, checked in the app; nothing is fetched from them).

alter table public.library_items drop constraint if exists library_items_kind_check;
alter table public.library_items add constraint library_items_kind_check
  check (kind in ('market', 'sector', 'setup', 'level', 'action', 'pattern', 'tactic', 'tag', 'mistake'));

alter table public.trade_labels add column if not exists links jsonb not null default '[]'
  check (jsonb_typeof(links) = 'array' and octet_length(links::text) <= 4000);
