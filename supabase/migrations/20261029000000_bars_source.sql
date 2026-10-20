-- Trade features groundwork (docs/journal-features.md): which provider each saved day of 5-minute bars came from.
-- Providers differ a little (volume from every exchange or one, extended-hours prints), so a feature can tell what it is
-- comparing, and one provider's days can be fetched again. Every row so far came from Tradier.

alter table public.bars_5m add column if not exists source text not null default 'tradier';
alter table public.bars_5m drop constraint if exists bars_5m_source_check;
alter table public.bars_5m add constraint bars_5m_source_check check (source ~ '^[a-z0-9_]{1,32}$');
