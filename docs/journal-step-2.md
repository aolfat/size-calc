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

Settings → Schwab trading → **Download Schwab history** saves one JSON file:
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

### 1. Capture

- **Migration:** `fills`, `stop_orders`, `bars_5m`, `import_runs`. Row-level security on every table, the user's rows deleted with the account, the existing `tests/rls.test.mjs` checks applying automatically.
- **Import:**
  - an Import button on the Journal tab
  - a quiet import of anything new when you open the Journal while logged in to Schwab
  - duplicates skipped by Schwab's id
  - progress kept in `import_runs`
- **Bars:** each held day's 5-minute bars are saved at import, one row per symbol per day.
- **Journal tab:** a new header tab. At this stage it shows "142 fills kept since Aug 15, last import 9:41" and the last import's result.

### 2. Trades

- **`core/journal.js`:** fills become trades, from flat back to flat.
  - first-in first-out, with scale-ins, partial exits and flips
  - the ×100 for options
  - a stable trade key (account, symbol, direction, open time), so notes added later never come loose
  - ported from LuxAlgo's MIT round-trip engine and tested against the spike's fixtures
- **Trade list:** date, symbol, long or short, size, average entry and exit, P&L, hold time, open or closed, R when there's a stop. You can filter by symbol, side and date.

### 3. Trade page

- **Charts:** daily and 5-minute, with entries, exits and stops drawn on them. This reuses `ui/candles.js` and the position chart's drawing.
- **Detail:** the fills table, the stop orders over time, P&L, R, hold time.

### 4. Calendar and stats

- **Calendar:** daily P&L with weekly totals.
- **Headline stats:** win rate, profit factor, average win and loss, expectancy, P&L over time.
- **Breakdowns:** by symbol, side, time of day, weekday and hold time. Groups under 10 trades are marked thin.

### 5. Saving plans from the app

Trade at Schwab tickets, and Positions' breakeven stops, targets and closes, save the plan (entry, stop, risk $, quantity, order id). Imports match it to the trade by order id.

## Tables (draft, settled after the spike)

| Table | One row per | Holds |
|---|---|---|
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
