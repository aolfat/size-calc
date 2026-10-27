-- Journal notebook (docs/journal-notebook.md): the premarket check-in gains whether you woke up before the open, one
-- checkmark, never required for the plan to count as written.

alter table public.journal_days add column if not exists woke_early boolean not null default false;
