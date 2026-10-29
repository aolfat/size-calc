-- Journal (docs/journal.md): a leveraged or inverse ETF's trade is a bet on its underlying (long SQQQ is short QQQ), so its
-- setup, side and charts read there. setup_on keeps one trade on the fund instead: the trade's own symbol, or null for the
-- underlying (the default, so trades before this need no row).
alter table public.trade_reviews add column if not exists setup_on text check (setup_on is null or length(setup_on) between 1 and 12);
