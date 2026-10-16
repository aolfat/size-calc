-- Journal step 3 (docs/journal-step-3.md): two notes on a trade. entry_note is written while it's live (why you're in,
-- the plan, what proves it wrong) and is optional; note stays the exit note (what happened, what you'd do differently),
-- which a trade needs to count as reviewed. Notes saved before this keep their place as exit notes.

alter table public.trade_reviews add column if not exists entry_note text;
