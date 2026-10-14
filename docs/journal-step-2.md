# Step 2: the journal

Status: planned. Step 0 (the data spike) is built. This is the next part of [the journal plan](journal-plan.md), after [step 1](journal-step-1-supabase.md) (Google sign-in and settings sync).

## Goal

A journal that fills itself from Schwab: every trade you make, wherever you place it, with P&L, R when there's a stop, charts with your fills, a P&L calendar, and stats. The review deck, labels, and notes come after this, in step 3.

## Principles

1. **Capture expiring data first.** Schwab keeps about 60 days of orders and Tradier about 40 days of 5-minute bars, so every week without an importer loses history for good. The first slice saves fills and bars, before most screens exist.
2. **Store facts, compute the rest.** Fills, stop orders and bars go in Supabase. Trades, P&L, R and stats are computed in the browser by pure functions in `src/core/`, tested with `node --test`, so fixing a calculation fixes every past trade.
3. **Ship slices you can use.** Each PR leaves something to look at or rely on.
4. **Build against real data.** The importer and grouping are tested against anonymized copies of your own Schwab history (step 0), not guesses about its format.

## Decisions

- **Trades come from Schwab, wherever they're placed.** The app's own plan is a bonus when you sized the trade here, never a requirement.
- **Initial stop, in order:**
  1. the first stop order working on the position when you entered, from Schwab's order history (you place one "sometimes")
  2. a plan saved in the app, if you sized it here
  3. otherwise none, and step 3's review card asks, with one-tap picks from the saved bars: the entry day's low, the entry candle's low, the prior day's low (highs for shorts)
- **R** = P&L ÷ (entry − initial stop) × quantity × multiplier. It's blank without a stop.
- **Option risk is chosen per trade, three ways:**
  - a stop on the underlying, priced with the chain's loss model
  - the premium paid, so 1R is the whole debit
  - a stop on the option price

  Default: a Schwab stop order on the option when there is one, otherwise premium paid. The choice is saved with the trade's review in step 3, and step 2 shows the default.
- **Saving plans from the app** (Trade at Schwab, Positions' breakeven stops, targets and closes, pinned cards) is a small extra at the end of step 2.

## Slices

### 0. Data spike (built)

The Journal's **Export** sheet → **Download Schwab history** (when you're connected to Schwab) saves one JSON file:
- your positions
- the last 59 days of orders
- `TRADE` transactions over 30, 60, 90, 180 and 365 days

Every account number and hash is masked. A summary at the top says how many rows each read returned and the dates they span, or why it failed. That answers how far back transactions go.

**What it settles:**
- **Where fills come from:** order execution legs (exact fill prices, times and order links, but only 60 days and no fees) or `TRADE` transactions (fees, open or close, maybe longer reach).
- **What options, partial fills, scale-ins, one-cancels-other pairs and triggers look like.**
- **How fees appear.**

**Next:**
1. You download the file and give it to me.
2. I turn it into anonymized test fixtures. Your real file never goes in the repo.
3. The button is removed once the importer lands.

### 1a. Raw capture (built)

Every Schwab order and `TRADE` transaction is kept exactly as Schwab sent it, with account numbers masked, in Supabase's `schwab_records`. This works before the parsing is designed: storing raw JSON doesn't depend on its format, so history stops expiring right away.

- **When it runs:**
  - **Automatically,** at most every 6 hours, once you're signed in with Google and connected to Schwab. It runs on sign-in, on connecting Schwab, and when you come back to the app.
  - **Import** on the Journal tab opens a sheet listing the sources: Schwab (with Import now) and file upload (coming soon). Opening the Journal also imports quietly when it's due.
  - **The Journal's status line** says when it last imported, and how many orders and trades.
- **What it reads:**
  - orders from the last 59 days
  - transactions a year back the first time, falling back to 59 days if Schwab refuses, then from a week before the last save
- **Storage:** one row per order (child orders stay inside their parent) and per transaction, keyed by Schwab's id. Re-reading an order updates it (working, then filled or canceled), and a record without an id is counted but not kept.
- **Each import is a delta (built):**
  - **What gets sent:** every record gets a fingerprint of its JSON. The import reads the fingerprints kept for the ids it just read, then sends only new orders, orders whose copy changed (a status or a fill), and new trades. A trade never changes once posted, so a kept one is skipped and never overwritten.
  - **What it reports:** the toast and status line say what happened, like "3 new trades, 2 orders updated, 71 already kept", or "Nothing new, 77 already kept".
- **What comes later:** fills, stop orders, trades and stats are derived from these rows, so a parsing fix re-runs over everything kept.

### 1. Capture

- **Migration:** `fills`, `stop_orders`, `bars_5m`, `import_runs`. Row-level security on every table, the user's rows deleted with the account, the existing `tests/rls.test.mjs` checks applying automatically.
- **Import:**
  - an Import button on the Journal tab
  - a quiet import of anything new when you open the Journal while logged in to Schwab
  - duplicates skipped by Schwab's id
  - progress kept in `import_runs`
- **Bars:** each held day's 5-minute bars are saved at import, one row per symbol per day.
- **Journal tab (built):**
  - **Placement:** a header tab between Positions and Tools, key `j`.
  - **What it shows:** what's kept ("46 orders and 31 trades kept · Aug 17 to Oct 14"), Import and Export buttons, the last import's result, and a table of the fills inside your saved orders (symbol, action, quantity, price, value, time), newest first.
  - **Import and Export are separate,** as in LuxAlgo's journal. Import is a sheet of sources (Schwab now, file upload later). Export is a sheet of files (Schwab history now, trades as CSV later).
  - **Signed out:** it asks you to sign in.
  - **Not connected to Schwab:** it points to Settings.

### 2. Trades (built)

- **`core/journal.js`:** fills become trades, from flat back to flat.
  - first-in first-out, with scale-ins, partial exits and flips
  - the ×100 for options
  - a stable trade key (account, symbol, direction, open time), so notes added later never come loose
  - ported from LuxAlgo's MIT round-trip engine and tested against the spike's fixtures
- **Trades are computed every time, never stored.** Trading-Journal-AI stores its trades, and much of its import code exists only to keep them consistent: it rebuilds stored trades that share a day with new fills, because its trade names (close date plus a counter that restarts each import) collide. Computing from kept fills avoids that whole class of bugs. Keying by open time, not close date, also keeps an open trade's key from changing when it closes.
- **Identical-looking fills are real.** A large order split into pieces can report fills with the same time, price and quantity. They stay separate because they're keyed by Schwab's execution ids, never deduped by content.
- **A trade's P&L belongs to its close date** (the day it was realized) in the calendar and in daily stats. Open trades are listed apart.
- **Trade list (built):**
  - **On the Journal:** a Trades | Fills switch, with Trades by default.
  - **Columns:** symbol, P&L and R first (phones see them before scrolling), then side, size, average entry and exit, hold time, and when it opened (ET). Open trades are marked.
  - **Filters:** side and symbol. A date filter comes with the calendar.
  - **Summary line:** closed trades, wins and win rate, P&L before fees, average R, open trades.
- **Initial stop and R (built):**
  - **The stop:** the first Schwab stop order that closes the position. It must be entered from 5 minutes before the first fill until the close, or be attached to the order that opened the trade (a resting entry's stop, entered hours before it fills), and sit on the loss side of the average entry.
  - **R:** P&L ÷ (|entry − stop| × quantity × multiplier).
  - **A long option with no stop** risks its premium.
  - **No stop at all:** no R yet. Step 3's review card asks.
- **Fees:** P&L is before fees for now. Schwab's orders carry none, so fees come from transactions once their real format is checked.

### 3. Trade page

- **Charts:** daily and 5-minute, with entries, exits and stops drawn on them. This reuses `ui/candles.js` and the position chart's drawing.
- **Detail:** the fills table, the stop orders over time, P&L, R, hold time.
- **Excursions, computed from the saved 5-minute bars over the hold.** Trading-Journal-AI defines these well but only fills them with demo data:
  - **MFE:** the best unrealized gain reached.
  - **MAE:** the worst unrealized loss reached.
  - **Exit efficiency:** realized gain ÷ MFE, the share of the move you captured. It's averaged over **winners only**, since a loser has no gain to capture.
  - **MAE is reported for winners and losers separately,** because the gap between the two calibrates the stop.

### 4. Calendar and stats

- **Calendar:** daily P&L with weekly totals.
- **Headline stats:** win rate, profit factor, average win and loss, expectancy, P&L over time.
- **Equity over time:** an equity curve, drawdown from the running peak, monthly results, and win and loss streaks.
- **Breakdowns:**
  - **By symbol:** top 40, with a warning when one name carries the account.
  - **By side, weekday and instrument.**
  - **By time of day,** bucketed on the first entry: 9:30–9:45, 9:45–10:30, 10:30–11:00, 11:00–13:30, 13:30–15:30, 15:30–16:00 (from Trading-Journal-AI).
  - **By hold time,** with winners' hold time against losers'.
  - **Scaled out against all-or-nothing:** more than one exit, or exactly one.
  - **R-multiple distribution,** for trades with an initial stop.
  - **Exit efficiency by setup,** once setups exist in step 3.
- **Every bucket shows the same stats:**
  - trades, net P&L, average and **median** P&L
  - win rate, average win and loss, profit factor
  - a count of big losses, measured in R (worse than −1.5R) so it scales with size, rather than a fixed dollar amount
- **Groups under 10 trades are marked thin.**

### 5. Saving plans from the app

Trade at Schwab tickets, and Positions' breakeven stops, targets and closes, save the plan (entry, stop, risk $, quantity, order id). Imports match it to the trade by order id.

### 6. Squash the migrations

The schema is new and lives in one database, so once slices 1 to 5 settle, the migrations fold into one baseline:
1. **Write one migration** with the final schema. Steps that cancel out disappear, like `saved_positions`, created and then dropped.
2. **Delete the old migration files.**
3. **Update Supabase's migration history** with `npx supabase migration repair`: the old versions marked reverted and the new one marked applied. The database itself doesn't change.
4. **Check the single file** against a scratch project. `tests/rls.test.mjs` keeps checking the rules either way.

Done once, at the end of step 2, after the journal's own tables exist.

## For step 3 (review), from Trading-Journal-AI

Not part of step 2, noted so the review design picks them up:
- **Goals:** targets for win rate, profit factor, day win rate, expectancy, average win/loss and exit efficiency. The dashboard measures you against them.
- **A setup grade, A++ to F,** on each trade, plus a "by grade" report that checks the ladder: if A trades don't beat C trades, the grading isn't telling you anything.
- **Idea source as a label:** where the idea came from (a scanner, a person, an alert, option flow), scored like setups and tags.
- **A label library that remembers aliases:** merging "ORB" into "Opening range" rewrites past trades and keeps the alias, so the old name maps to the kept one from then on.
- **The weekly review's shape:** your most repeated mistake, your most consistent edge, and one rule for next week. Trading-Journal-AI has AI write it; ours could start from plain stats (the most costly mistake in R).

## Tables (draft, settled after the spike)

| Table | One row per | Holds |
|---|---|---|
| `schwab_records` (built) | Order or transaction | Kind, Schwab's id, account (last 4 digits), entered time, Schwab's JSON whole with account numbers masked |
| `fills` | Fill | Schwab id (unique per account), order id, symbol (options by full contract symbol), underlying, asset type, side, quantity, price, fee, time, open or close |
| `stop_orders` | Stop order | Order id, symbol, side, quantity, stop price, entered, status, what replaced it |
| `bars_5m` | Symbol per day | That day's 5-minute bars packed in one value |
| `import_runs` | Import | When, account (last 4 only), imported through, counts, errors |

Every table follows the rules in `tests/rls.test.mjs`: a `user_id` defaulting to the signed-in user and deleted with the account, row-level security with an owner rule, and nothing granted to `anon`.

## Open questions

- **Before slice 1:** fills from orders or transactions (the spike decides).
- **Before slice 2:** do open positions appear in the journal as open trades, or only in Positions?
- **Before slice 4:** which stats matter most.
- **Later:** backfilling older history from Schwab's website export.
