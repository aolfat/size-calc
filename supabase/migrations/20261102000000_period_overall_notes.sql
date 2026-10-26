-- Journal step 3, slice 6, part 2 (docs/journal-step-3.md): the overall notes on a week's or a month's review, beside
-- each part's own note: what went well, what to work on, and anything else. Optional: reviewed_at never waits on them.
-- The app reads them on their own query, so before this push the rest of the review still works.

alter table public.period_reviews add column if not exists went_well text check (length(went_well) <= 5000);
alter table public.period_reviews add column if not exists work_on text check (length(work_on) <= 5000);
alter table public.period_reviews add column if not exists note text check (length(note) <= 5000);
