-- Futures fills from thinkorswim statements, kept beside the Schwab records they sit with in the journal. Schwab's API
-- has no futures (they're held by Schwab's futures firm), so the journal reads them from an exported Account Statement:
-- one row per fill, kind 'statement_fill', record_id 'tos:<order number>:<n>', data = the fill (contract, side, qty,
-- price, fees, time). Same table, same row-level security and owner rule.
alter table public.schwab_records drop constraint if exists schwab_records_kind_check;
alter table public.schwab_records add constraint schwab_records_kind_check check (kind in ('order', 'transaction', 'statement_fill'));
