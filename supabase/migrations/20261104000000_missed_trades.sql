-- Journal notebook (docs/journal-notebook.md): the trades you missed on a day, the ones you saw and didn't take, kept
-- on its journal_days row: [{ id, symbol, side, setup, tactic, why, note }], at most 20 (the app cleans them on the way in).
-- The app reads the column on its own query, so before this push the rest of the notebook still works.

alter table public.journal_days add column if not exists missed jsonb not null default '[]'
  check (jsonb_typeof(missed) = 'array' and octet_length(missed::text) <= 20000);
