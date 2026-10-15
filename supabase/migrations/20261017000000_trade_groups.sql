-- Journal step 2: option legs you combine into one spread (legged in, or a multi-leg order you'd rather split). Each
-- leg's review row names the spread it belongs to; 'solo' keeps a leg on its own even when its order opened other legs.
-- Legs opened in one multi-leg order combine without a row. The spread's own row (its delete mark) uses the spread's key.

alter table public.trade_reviews add column group_key text check (group_key is null or length(group_key) between 1 and 200);
