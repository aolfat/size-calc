-- Journal notebook, slice 1 (docs/journal-notebook.md): a page per trading day. journal_days (one row per user and New
-- York day, made by the first review migration with the day's market and a note) gains the premarket plan (a mental
-- check-in, the plan, a focus list for slice 2) and the post-market review (a grade, each rule kept or broken, two guided
-- notes, tomorrow's focus and whether the last one was kept); note stays the day's free note. Goals and rules are standing
-- lists kept in library_items like your setups, so each has a stable id and rewording one keeps its history.

alter table public.journal_days add column if not exists feelings jsonb not null default '[]'
  check (jsonb_typeof(feelings) = 'array' and octet_length(feelings::text) <= 500);
alter table public.journal_days add column if not exists energy text check (energy in ('rested', 'ok', 'tired'));
alter table public.journal_days add column if not exists sleep_hours numeric check (sleep_hours is null or (sleep_hours >= 0 and sleep_hours <= 24));
alter table public.journal_days add column if not exists place text check (place in ('desk', 'phone'));
alter table public.journal_days add column if not exists plan text check (length(plan) <= 5000);
alter table public.journal_days add column if not exists focus_list jsonb not null default '[]' -- slice 2: [{ symbol, note }]
  check (jsonb_typeof(focus_list) = 'array' and octet_length(focus_list::text) <= 8000);
alter table public.journal_days add column if not exists grade text check (grade in ('A', 'B', 'C', 'D', 'F'));
alter table public.journal_days add column if not exists rules jsonb not null default '{}' -- rule key → 'kept' | 'broke'
  check (jsonb_typeof(rules) = 'object' and octet_length(rules::text) <= 8000);
alter table public.journal_days add column if not exists went_well text check (length(went_well) <= 5000);
alter table public.journal_days add column if not exists work_on text check (length(work_on) <= 5000);
alter table public.journal_days add column if not exists focus_next text check (length(focus_next) <= 500);
alter table public.journal_days add column if not exists focus_kept text check (focus_kept in ('yes', 'partly', 'no'));
alter table public.journal_days add column if not exists planned_at timestamptz; -- set while the plan has everything it asks for
alter table public.journal_days add column if not exists reviewed_at timestamptz; -- set while the review does

alter table public.library_items drop constraint if exists library_items_kind_check;
alter table public.library_items add constraint library_items_kind_check
  check (kind in ('market', 'sector', 'setup', 'level', 'action', 'pattern', 'tactic', 'tag', 'mistake', 'goal', 'rule'));
-- a goal runs longer than a chip's name; the app keeps every other item at 80
alter table public.library_items drop constraint if exists library_items_name_check;
alter table public.library_items add constraint library_items_name_check check (length(name) between 1 and 200);
