-- Journal notebook (docs/journal-notebook.md): the day's focus list, the tickers you're watching. The column came with the
-- notebook's migration for this; each ticker now keeps [{ id, symbol, side, setups, note, played, review }], up to 12 (the
-- app cleans them on the way in), so its size limit grows from 8000 bytes to 30000, like the missed trades' room.

alter table public.journal_days drop constraint if exists journal_days_focus_list_check;
alter table public.journal_days add constraint journal_days_focus_list_check
  check (jsonb_typeof(focus_list) = 'array' and octet_length(focus_list::text) <= 30000);
