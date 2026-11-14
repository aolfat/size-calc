-- The setup's grade on an order plan (docs/schwab.md, docs/journal.md): the Trade at Schwab sheet grades the setup A to F
-- when the order goes, and the journal puts it on the trade's review as its Setup grade once, when the review has none.
-- The same grades the trade review takes (trade_reviews.setup_grade, without the old A++). Null when none was picked.

alter table public.order_plans add column if not exists setup_grade text check (setup_grade in ('A', 'B', 'C', 'D', 'F'));
