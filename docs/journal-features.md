# Trade features

Status: part 1 (saving the raw data) and part 2 (features stamped onto every trade, the Journal's Features tab, a Features tab on each trade page) built, with the full first catalog (72 features in 8 families), market breadth from Massive, and older 5-minute history from a paid Massive plan. Part 3 (the Conditions filter, the Stats explorer, features as list columns) next. Part of [the journal plan](journal-plan.md), beside [step 3](journal-step-3.md)'s review labels.

## Goal

Every trade carries facts about the moment it was taken: was SPY over its daily 8 EMA, was the entry over VWAP, how heavy was volume against a normal day by that time, how far was the stock from its all-time high. Then the year's trades can be cut by any of them: how did every trade do when SPY and QQQ were both over the 8 EMA?

Labels (step 3) are what you say about a trade. Features are what the data says, worked out by the app, never typed.

## Principles

1. **Adding a feature is one entry and one test.** No migration, no UI work, no stamping code. You'll want hundreds over time, so the cost of each has to be close to nothing.
2. **A new feature stamps itself onto every past trade.** So does a changed one. Nothing has to be run by hand.
3. **Keep the raw data, never just the answers.** A feature can only be filled in for trades whose data was kept. Daily bars can be fetched any time; 5-minute bars only for about 40 days at Tradier. So the journal saves wide now, before anyone knows which features they'll want.
4. **No look-ahead.** A feature sees data up to its moment (the entry, or the exit) and nothing after. The system cuts the data off, not each feature.
5. **Stamp the number, not the bucket.** 2.34×, not "2–3×". Buckets are only for grouping in Stats, and changing them never restamps.
6. **The provider can change.** Bars are saved in the app's own form, behind one fetching seam, and each saved day names where it came from.

## Part 1: saving the raw data (built)

- **Provider seam:** `src/services/bar-source.js` holds the providers: `barSource` (Tradier: daily bars, and 5-minute bars inside its window) and `massiveSource` (Massive's 5-minute aggregates for older days; see [Older history from Massive](#older-history-from-massive-built)). `services/bars.js` fetches through them and never calls a provider itself. Daily bars joined the seam in part 2 (`barSource.daily`).
- **The app's form:** symbols are the OCC symbol without its padding (`AAPL261218C00245000`, a stock as itself), days are New York days, a bar is stamped with its start in New York time ('09:30' = 9:30 to 9:35), rows are `[time, open, high, low, close, volume]`, extended hours included (04:00 to 20:00). A provider whose symbols or stamps differ translates them in its own entry.
- **Source:** `bars_5m.source` (migration `20261029000000_bars_source.sql`, default `tradier`). Providers differ a little (volume from every exchange or one, extended-hours prints), so a feature can tell what it compares, and one provider's days can be fetched again. Before the push, rows save without it.
- **Market basket** (`MARKET_BASKET` in `core/bars.js`): SPY, QQQ, IWM, DIA and the 11 sector SPDRs, saved every weekday whether you traded or not, so market features work for every trade. VIX is left out until it's checked that Tradier serves it intraday.
- **Lookback** (`LOOKBACK_DAYS`, 20, raised by any feature that compares more: the run rate's curve takes 50): the weekdays before each trade's open are saved for its stock (an option's underlying, not the contract), for comparisons like the volume run rate.
- **Window:** all of it within the last 35 days (`BARS_KEEP_DAYS`), finished days only. The first run fills in everything Tradier still has. It runs when the Journal opens and after an import, at most hourly, with a Tradier key in Settings; open the Journal at least every few weeks or days fall out of Tradier's window for good (a paid Massive plan serves them again).
- **Size:** about 9 KB a saved day. See [Storage](#storage-bars_5m-against-supabases-500-mb) for the estimate and why a paid Massive plan saves less.

## Part 2: features and stamping (built)

### A feature

One entry in a features file under `src/core/features/`, grouped by family (`market.js`, `volume.js`, `levels.js`, `timing.js`):

```js
feature({
  key: 'rvol_at_entry',             // permanent, never reused
  name: 'Volume run rate at entry', // free to rename
  version: 1,                       // bump when the definition changes
  at: 'entry',                      // or 'exit'
  needs: { intraday: ['$underlying'], lookback: 20, session: 'regular' },
  unit: 'x',
  compute: ({ intraday }) => {
    const s = intraday('$underlying');
    return s.volumeSoFar() / s.avgVolumeByTime(20); // vs the same time of day, prior 20 sessions
  },
})
```

- `$self` is the traded symbol, `$underlying` the stock (an option's underlying). Other symbols by name ('SPY').
- `compute` returns a number, a word from its `values`, or null (unknown). It reads data through shared helpers (`ema`, `vwap`, `volumeSoFar`, `maxHigh`), each worked out once per trade, not once per feature.
- **Families:** one generator can make many features (8 / 21 / 50 / 200 EMA × SPY / QQQ / IWM / the stock × daily / 5-minute). Families carry a version too, so a fix to a shared helper restamps what uses it.

### Stamping

- **Where:** a `trade_features` table, one row per trade key: `{ key: { v, value } }` in one JSON column, row-level security like every table. Hundreds of features stay one row a trade.
- **When:** each Journal load compares the feature list with each trade's stamps. A feature missing or with a newer version is due. The stamper gathers what the due features need, reads the saved bars (fetching what the provider still has), computes, and saves, with a quiet progress line ('Stamping 3 new features on 412 trades…'). Trades from a new import are stamped the same way.
- **Three states:** a value; unknown for good (the data is gone: recorded with its version, never retried); waiting (the data could still come, like today's bars: tried again later).
- **Features drive saving:** the bar saver reads `needs`. A feature that needs XLK, or 30 days of lookback, makes the app save that from then on. The past fills in as far as the provider has it: years for daily bars, about 40 days for 5-minute bars at Tradier.
- **Changing your mind:** edit = bump `version`, that feature restamps. Rename = change `name`, nothing restamps. Delete = remove the entry, its old stamps are ignored and cleaned up. A trade's key changing (merge, separate) gets stamped under the new key.
- **Big backfills:** a new feature over a year reads every saved bar once. In the browser that goes in chunks; `core/` is pure, so a local Node script can do it with the same code.

### Checks over every feature

- **No look-ahead:** each feature computed with data cut off at its moment and again with the whole day must agree.
- **Contract:** a unique key, a version, and only declared values, numbers or null.

### As built

- **Files:** `src/core/features/` (pure, `// @ts-check`): `define.js` (`family`, `feature`), `context.js` (the cut and the shared helpers), `prices.js` (the moment's price in the daily history's terms, a median, words), one file per family (`market.js`, `breadth.js`, `volume.js`, `trend.js`, `levels.js`, `strength.js`, `contract.js`, `timing.js`), `index.js` (FEATURES, due, data needs, compute, stamp, coverage, words). `services/features.js` reads and writes `trade_features` and reads the kept bars; `ui/journal-features.js` runs the stamper and draws the Journal's Features tab and the trade page's Features tab.
- **A feature** also has `desc` (what it measures, for the Features tab). `needs` is `{ intraday, lookback, daily, dailySessions, session, breadth }` (none at all = it reads only the trade itself: its time, its contract); the contract test fails a feature that reads anything it doesn't declare, so `needs` stays true and the saver and the stamper can trust it.
- **The cut:** a 5-minute bar counts once it has ended; the bar the moment falls in shows only its open. Daily bars are the days before the moment's day, plus that day's open from 9:30. The trade itself shows only its symbol, type and open time (and the close, for an exit feature): no exit, P&L or R at the entry.
- **Stamps:** `trade_features` (migration `20261030000000_trade_features.sql`), `stamps` = `{ key: { v: '<family version>.<feature version>', value, note } }`. Unknown is `value: null` with the why in `note`, and for a feature reading 5-minute bars the reach it was worked out under (`r`, when wider than Tradier's; see Older history from Massive). Waiting isn't stored: the last run's reasons are kept on the device for the trade page.
- **Which trades:** every one but deleted trades and closes from before your history (no entry). A restored trade is stamped on the next load. Rows under an old key (a merge, a separate) are left, not deleted: a key can vanish for a moment while records load.
- **Runs:** after the Journal loads (once the bar saver is done, so today's saves count) and after an import. Chunks of 40 trades: each reads its bars, computes, saves. Only waiting features left: tried again at most every 15 minutes. Daily bars are read once a run per symbol, back to 1960 when a feature wants the listing; without a Tradier key, daily features wait.
- **Splits:** Tradier's docs don't say whether `/markets/history` is split-adjusted (they say it "usually" covers the company's lifetime). So the features that compare daily history with the day's own prices line them up first (`dailyBasis`): the exact ratio of that day's 9:30 open in the 5-minute bars and the daily bar's open, or, without that day's bars, the fill against the daily open (or the close before) at the nearest of no split and the usual split ratios, allowing a day's 30% move. Nothing lines up: unknown, never a made-up number.
- **The all-time high** keeps no `{ high, date, through }` summary yet: the daily history is read whole on each run that needs it (one call per symbol). Worth adding if runs get slow.

### Worked examples

- **Relative volume by time of day** (`rvol_at_entry`, first named "Volume run rate at entry"): volume from 9:30 to the entry bar over the average volume to that same time across the prior 20 sessions (volume is U-shaped, so a straight 'so far ÷ fraction of the day' makes every early entry look hot). Fills in for trades whose lookback days were saved.
- **Volume run rate** (`run_rate_20`, `run_rate_50`, `run_rate_20_at_exit`), the owner's TradingView indicator: projected full-day volume ÷ the median daily volume of the N sessions before, stamped as the % over it (+34 = 1.34×).
  - `projected = PM + prints_so_far ÷ U(now)`. PM is the day's premarket (4:00 to 9:30), over by the open, so added as it is. prints_so_far is the regular-hours volume in the 5-minute bars ended by the moment.
  - U(now) is the stock's own curve: over the 50 sessions before, the share of each day's whole volume less its premarket that had printed in regular-hours bars by the same 5-minute mark, averaged. The denominator is the daily total (daily bars), not the sum of the 5-minute bars: those miss the closing auction, after-hours and late prints, so U at the close is about 0.65 to 0.80, and dividing by it projects the whole day, which is what the median measures. No interpolation: the cut is a 5-minute mark, and U is read at the same mark.
  - Guardrails: none before 9:35 (no ended bar) or before the open; '~ first 15 minutes, noisy' in the note before 9:45; half days (`earlyCloseDay`: July 3 and December 24 Monday to Thursday, the day after Thanksgiving) are left out of the curve and get none themselves; at least 15 curve sessions, noted 'curve from 23 sessions'.
  - The curve wants 50 sessions of 5-minute bars, and Tradier serves about 40 days: a stock's bars are kept around your trades from now on (lookback 50), so older trades' curves are shorter, and below 15 sessions it's unknown.
- **Distance from the all-time high:** entry over the highest prior high (every prior day, plus today's before the entry), as a %. Needs daily bars back to the listing, which providers serve any time, so it stamps for the whole history at once. Only per symbol `{ high, date, through }` has to be kept. Needs split-adjusted prices (to be checked at Tradier; after a split the symbol's history is fetched again), and says 'high since 1998' when the provider's history starts after the listing.
- **SPY / QQQ over the daily 8 EMA at entry:** SPY's price at the entry bar against the daily 8 EMA updated with that price, so it never sees the day's close. Without SPY's 5-minute bars that day, the prior close against the prior EMA, flagged as such.
- **Entry over VWAP:** the underlying at the fill time against its session VWAP (for an option, the underlying's, not the option's).

## The catalog (built)

72 features in 8 families. "Moved on by" = the daily average updated with the moment's price as one more close, so it never sees the day's close. An option reads its underlying, a stock entry uses your fill.

- **Market** (19): SPY / QQQ / IWM vs daily 8 and 21 EMA, 50 and 200 SMA; SPY / QQQ / IWM on the day; SPY / QQQ vs VWAP; how many of the 11 sector SPDRs are over their daily 8 / 21 EMA.
- **Market breadth** (5): % of US common stocks over their 5 / 20 / 50 / 100 / 200-day SMA at the close before (see below).
- **Volume** (9): relative volume by time of day; run rate 20 / 50, and 20 at the exit; premarket vs usual (median, to the same time); the last ended bar vs that bar's average; the prior day vs its 50-day median; up / down volume over 50 days; median dollar volume over 20 days.
- **Trend** (13): the stock vs daily 8 / 21 EMA, 50 / 200 SMA, and the exit vs the 8 EMA; extension from the 21 EMA in ADRs; ADR % (20); ATR % (14, Wilder's); distance from the 52-week high and sessions since it; the 10-day range in ADRs (tightness); the prior day as inside / NR7; the prior day's change.
- **Levels** (14): entry vs VWAP; the gap at the open; distance from the all-time high; entry vs the prior day's range; vs the 5 / 15 / 30-minute opening range; where in the day's range; % of ADR used; vs the 5-minute 8 / 21 EMA (carried over from the two sessions before); gap filled; vs the day's open; the exit vs VWAP.
- **Relative strength** (4): 20 / 63-day return less SPY's; the RS line (stock ÷ SPY) at a 50-day high; the day so far less SPY's.
- **Options** (6, option trades only): days to expiry; strike out of the money; the IV and delta your fill implies (Black-Scholes, 4%, no dividends); IV over HV20; premium as % of the stock.
- **Timing** (2): minutes after the open; premarket / regular / after hours.

Not built yet, for want of data: VIX (Tradier's VIX history unchecked), earnings (no calendar source; Tradier's is beta), a stock's sector ETF (no stock → sector map), an option's own volume or spread at entry.

## Market breadth (built)

Barchart publishes $MMFD, $MMTW, $MMFI, $MMOH and $MMTH (the % of stocks over their 5 / 20 / 50 / 100 / 200-day average) but sells no API an individual can buy (its OnDemand pricing is a sales quote), TradingView has no API, and Tradier doesn't serve them. So the app counts them itself from Massive (formerly Polygon), whose free plan's grouped daily bars return every US stock's daily bar for a date in one call.

- **Universe:** active US-listed common stocks (Massive's reference tickers, type CS: no ETFs, funds, warrants or preferreds), read once a month. Close to Barchart's shape, not its exact numbers: its universe isn't published, delisted stocks aren't in today's list (old readings run a little high), and a split after a day was kept leaves that stock off its averages for a while (grouped bars are adjusted as of the day they're read).
- **The count** (`core/breadth.js`, pure): days in order; per stock a running sum per average; a stock above its N-day SMA (that day's close in it) counts above; a stock with fewer than N closes isn't counted; a missing weekday starts every average over; a shut day is `{ closed: true }`.
- **Reading** (`ui/journal-breadth.js`): with a Massive key in Settings (device-local, never synced), after the Journal loads, at most hourly. It works out the days still needed (from the session before your first trade, each day's longest average's sessions before it, inside the free plan's two years), newest first so recent trades fill in first, one call every 12.5 seconds (5 a minute). A first fill over a year of trades is a few hundred calls, about an hour and a half while the app is open; it carries on where it stopped. Each day's closes stay on the device (IndexedDB, `lib/idb.js`); every 10 days the counts are worked out and the changed days saved.
- **Saved:** `market_breadth` (migration `20261031000000_market_breadth.sql`), one row per (user, universe, day), so every device's features read the same counts and only one device needs the key.
- **The features** read the close before the moment's day (`ctx.breadth(n)`; shut days stepped over). A day not counted yet waits while it's inside the two years; older, it's unknown. Without a key or before the push, they wait, and the Features tab says why.

## Older history from Massive (built)

Tradier serves about 40 days of 5-minute bars, so every intraday feature on an older trade was unknown for good. Massive's paid plans serve years of them: Stocks Starter ($29 a month) five years of stocks with unlimited calls, Options Starter two years of option contracts. With a key and a paid plan picked in Settings, older trades fill in.

- **Settings:** Massive **Plan** beside the key (`massive_plan`: Free, Stocks Starter, Stocks + Options; device-local like the key, gone with it on sign out). `MASSIVE_PLANS` in `core/bars.js` says each plan's years and whether it's paid. The app can't tell a plan from the key, so the setting says. A free key set as paid is caught by the 429 wait (a minute, up to three times).
- **Pacing:** the free plan's 12.5 seconds between calls stays for every Massive call (`massivePaced` in `ui/journal-breadth.js`, shared by the breadth and the bars). A paid plan isn't paced. The free plan's minute bars aren't used: its 5 calls a minute go to the breadth, and a year of trades' lookback days would be thousands of calls.
- **The provider:** `massiveSource.intraday` asks `/v2/aggs/ticker/{T}/range/5/minute/{from}/{to}?adjusted=false&sort=asc&limit=50000` with the key in a Bearer header and follows `next_url`. An option's ticker is `O:` plus the OCC symbol without spaces (`O:AAPL261218C00245000`). Each bar's start (epoch ms) becomes a New York day and an 'HH:MM' start, 04:00 to 20:00, so it answers exactly as Tradier's timesales do (`massiveByDay`). Unadjusted, like Tradier's.
- **Routing:** `barRoute` sends a finished day to Tradier inside its window (35 days, `BARS_KEEP_DAYS`), to Massive older (within the plan's years, a week inside them), else nowhere. The stamper reads per trade and symbol (`intradayRoutes`): the kept bars when they hold every finished day the trade's due features read; else, when Massive serves the symbol back to the oldest of them, every one of those days from Massive (the recent ones too); else the kept bars, the missing days waiting or gone.
- **One provider per trade and symbol, on purpose:** a run rate's curve compares 50 sessions of 5-minute volume, and a relative volume 20. Two providers count volume a little differently (exchanges, odd lots, late prints), and a curve spliced from both would shift where the splice falls. So a trade's comparison is all Tradier's or all Massive's, never mixed. A trade whose days are all kept keeps its answer when Massive comes in. The stamper's read of bars_5m (`loadKeptBars`) skips rows named `massive` (the trade page's, below) for the same reason.
- **Waiting vs gone:** `couldCome` in `core/features/context.js` asks the reach for that kind of symbol (`barsReach(now, plan)`: Tradier's window, a paid plan's stocks and options years). A day Massive can still serve is waiting, not gone.
- **Retrying the old unknowns:** an unknown stamp of a feature that reads 5-minute bars carries the reach it was worked out under (`r`: `massive` or `massive_options`; absent means Tradier's, which is every stamp from before). `featureDue` makes it due again when the reach now is wider than its `r`, once: tried again, it carries the new reach. A narrower reach (a plan dropped) never restamps, and no feature's version changes. Picking a plan (or entering a key) runs the stamper at once.
- **Daily bars** stay Tradier's (it serves them back to the listing).

### Storage: bars_5m against Supabase's 500 MB

About 9 KB a saved day (192 extended-hours bars). A year of trades, say 500 trades on 150 names, half of them options:

| What | Days a year | Size |
|---|---|---|
| Market basket (15 symbols every weekday) | 3,780 | 34 MB |
| Your stocks' 50 lookback days and held days (repeat names overlap) | 10,000 to 20,000 | 90 to 180 MB |
| Option contracts' held days | about 500 | 5 MB |
| **Total** | 14,000 to 24,000 | **130 to 220 MB** |

That's the saver's rate today, and it leaves two or three years in the free 500 MB. Copying a paid plan's five years into bars_5m would be five times that, which doesn't fit. Capping it would throw away the history the plan pays for.

So the app stamps straight from the provider and keeps bars_5m for what would otherwise be lost and for the charts:

- Massive's days are cached on the device (IndexedDB, `bars5m_massive:<symbol>|<day>`), never saved to the account. The 6,000 days read most recently are kept, about 60 MB, and the cache goes on sign out (the symbols say what you traded). A restamp after a version bump reads the cache, then Massive again for what's gone. Massive serves the days again any time, so losing the cache costs only calls.
- With a paid plan, the saver keeps only the days your trades were open (`barsToKeep`: no basket, no lookback), for the trade pages' charts: about 1,500 days a year, some 14 MB. Without one it saves as before, since Tradier drops the days after 40.
- A trade page opened on an older trade reads its held days from Massive and saves them (source `massive`), so the next open reads bars_5m. Its context days before the open come from Massive too and aren't saved.

The trade-off: if a paid plan ends, the trades from while it ran have no lookback days in bars_5m. Their stamps stay. Only a version bump on those features would leave them unknown, and Tradier's window then fills recent trades as before.

## Part 3: the features page, filters and stats

- **Features page** (built in part 2, the Journal's Features tab): every feature with its name, what it measures, what it reads, its version, and how far it's stamped ('412 of 430, 18 unknown: bars too old, 3 to come'). Grouped by family. It's read from the feature list, so a new feature shows up there by itself. Search comes with the Conditions picker.
- **On the trade:** the trade page's Features tab (built in part 2, beside Review) lists every feature by family with its value, each tapping open to what it measures and reads; any can be a column in the trades list (part 3).
- **Conditions filter:** beside All setups, over Trades, Calendar and Stats. A searchable picker by family with pinned favorites; numbers take any threshold ('run rate ≥ 1.8'), words pick values. Conditions combine, and a combination can be saved as a named view.
- **Stats:** a feature explorer (pick any feature, see its breakdown with groupStats' numbers). Numbers group into five equal-size groups by default (quintiles), or the feature's own bins where given.
- **What matters (later):** features ranked by how much results differ between their groups. Test hundreds and some look meaningful by chance, so thin groups are dimmed, a pattern has to hold in both halves of the history, and it's a list of leads, not rules.

## Open questions

- Is Tradier's daily history split-adjusted, and how far back does it go for an old stock? The docs don't say either; the features line the history up with the day's own prices (see Splits above), so they're right either way. Worth one check against a real key (a stock that split, like NVDA in June 2024).
- Does Tradier serve VIX timesales?
- Do Tradier's and Massive's 5-minute volumes agree? Both should be the consolidated tape, but a run rate from Massive's bars still divides by Tradier's daily totals. Worth one side-by-side on a stock inside Tradier's window once a paid key is in.
- Does Massive serve 5-minute bars on its free plan, and how far back? The app doesn't use them (the 5 calls a minute go to the breadth), so it's only worth checking if the free plan should ever fill old trades slowly.
- How close the app's breadth runs to Barchart's: worth one side-by-side against $MMTW on TradingView once a few months are counted.
