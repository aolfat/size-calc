-- Journal step 3, slice 6, part 2 (docs/journal-step-3.md): grades and notes on a week's or a month's review. One row per
-- (user, unit, period): a week by its Monday ('2026-10-12'), a month as 'YYYY-MM'. Each part of the self-assessment
-- (PERIOD_CATEGORIES in src/core/journal-week.js) has its own grade and note column, so saving one never overwrites
-- another. rule_next is the one rule for the next period; rule_kept says whether the period before's rule was kept.
-- reviewed_at is set while every part has a grade and the rule is set.

create table if not exists public.period_reviews (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  unit text not null check (unit in ('week', 'month')),
  period_key text not null check ((unit = 'week' and period_key ~ '^\d{4}-\d{2}-\d{2}$') or (unit = 'month' and period_key ~ '^\d{4}-\d{2}$')),
  selection_grade text check (selection_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  selection_note text check (length(selection_note) <= 5000),
  entry_grade text check (entry_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  entry_note text check (length(entry_note) <= 5000),
  exit_grade text check (exit_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  exit_note text check (length(exit_note) <= 5000),
  risk_grade text check (risk_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  risk_note text check (length(risk_note) <= 5000),
  emotion_grade text check (emotion_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  emotion_note text check (length(emotion_note) <= 5000),
  market_grade text check (market_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  market_note text check (length(market_note) <= 5000),
  prep_grade text check (prep_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  prep_note text check (length(prep_note) <= 5000),
  consistency_grade text check (consistency_grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F')),
  consistency_note text check (length(consistency_note) <= 5000),
  rule_next text check (length(rule_next) <= 500),
  rule_kept text check (rule_kept in ('yes', 'partly', 'no')),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, unit, period_key)
);

create or replace trigger period_reviews_touch before insert or update on public.period_reviews
  for each row execute function public.touch_updated_at();

alter table public.period_reviews enable row level security;
drop policy if exists period_reviews_owner on public.period_reviews;
create policy period_reviews_owner on public.period_reviews for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.period_reviews from anon;
grant select, insert, update, delete on public.period_reviews to authenticated;
