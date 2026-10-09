-- Saved position cards were retired on main (Positions now shows live Schwab positions), so the account no longer
-- keeps them. Nothing reads or writes this table; the only rows in it came from a test sign-in.
drop table if exists public.saved_positions;
