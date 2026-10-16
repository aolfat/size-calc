-- Journal step 3: the setup grade runs A to F. A++ came over from Trading-Journal-AI and was one step too many at the
-- top, so a trade graded A++ is now an A. The app reads a leftover A++ as A until this runs.

update public.trade_reviews set setup_grade = 'A' where setup_grade = 'A++';
alter table public.trade_reviews drop constraint if exists trade_reviews_setup_grade_check;
alter table public.trade_reviews add constraint trade_reviews_setup_grade_check
  check (setup_grade in ('A', 'B', 'C', 'D', 'F'));
