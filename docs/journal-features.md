# Trade features

Status: part 1 (saving the raw data) and part 2 (features stamped onto every trade, the Features tab, At entry on the trade page) built. Part 3 (the Conditions filter, the Stats explorer, features as list columns) next. Part of [the journal plan](journal-plan.md), beside [step 3](journal-step-3.md)'s review labels.

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

- **Provider seam:** `src/services/bar-source.js` holds the provider in use (`barSource`, Tradier for now). `services/bars.js` fetches through it and never calls Tradier itself. Moving off Tradier is a new provider in that file. Daily bars joined the seam in part 2 (`barSource.daily`).
- **The app's form:** symbols are the OCC symbol without its padding (`AAPL261218C00245000`, a stock as itself), days are New York days, a bar is stamped with its start in New York time ('09:30' = 9:30 to 9:35), rows are `[time, open, high, low, close, volume]`, extended hours included (04:00 to 20:00). A provider whose symbols or stamps differ translates them in its own entry.
- **Source:** `bars_5m.source` (migration `20261029000000_bars_source.sql`, default `tradier`). Providers differ a little (volume from every exchange or one, extended-hours prints), so a feature can tell what it compares, and one provider's days can be fetched again. Before the push, rows save without it.
- **Market basket** (`MARKET_BASKET` in `core/bars.js`): SPY, QQQ, IWM, DIA and the 11 sector SPDRs, saved every weekday whether you traded or not, so market features work for every trade. VIX is left out until it's checked that Tradier serves it intraday.
- **Lookback** (`LOOKBACK_DAYS`, 20): the weekdays before each trade's open are saved for its stock (an option's underlying, not the contract), for comparisons like the volume run rate.
- **Window:** all of it within the last 35 days (`BARS_KEEP_DAYS`), finished days only. The first run fills in everything Tradier still has. It runs when the Journal opens and after an import, at most hourly, with a Tradier key in Settings; open the Journal at least every few weeks or days fall out of Tradier's window for good.
- **Size:** about 9 KB a saved day. The basket is about 15 × 252 days a year, plus your symbols. Watch it against Supabase's free 500 MB; packing bars tighter is the fix if it grows.

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

- **Files:** `src/core/features/` (pure, `// @ts-check`): `define.js` (`family`, `feature`), `context.js` (the cut and the shared helpers), one file per family (`market.js`, `volume.js`, `levels.js`), `index.js` (FEATURES, due, data needs, compute, stamp, coverage, words). `services/features.js` reads and writes `trade_features` and reads the kept bars; `ui/journal-features.js` runs the stamper and draws the Features tab and the trade page's At entry section.
- **A feature** also has `desc` (what it measures, for the Features tab). `needs` is `{ intraday, lookback, daily, dailySessions, session }`; the contract test fails a feature that reads anything it doesn't declare, so `needs` stays true and the saver and the stamper can trust it.
- **The cut:** a 5-minute bar counts once it has ended; the bar the moment falls in shows only its open. Daily bars are the days before the moment's day, plus that day's open from 9:30. The trade itself shows only its symbol, type and open time (and the close, for an exit feature): no exit, P&L or R at the entry.
- **Stamps:** `trade_features` (migration `20261030000000_trade_features.sql`), `stamps` = `{ key: { v: '<family version>.<feature version>', value, note } }`. Unknown is `value: null` with the why in `note`. Waiting isn't stored: the last run's reasons are kept on the device for the trade page.
- **Which trades:** every one but deleted trades and closes from before your history (no entry). A restored trade is stamped on the next load. Rows under an old key (a merge, a separate) are left, not deleted: a key can vanish for a moment while records load.
- **Runs:** after the Journal loads (once the bar saver is done, so today's saves count) and after an import. Chunks of 40 trades: each reads its bars, computes, saves. Only waiting features left: tried again at most every 15 minutes. Daily bars are read once a run per symbol, back to 1960 when a feature wants the listing; without a Tradier key, daily features wait.
- **Splits:** Tradier's docs don't say whether `/markets/history` is split-adjusted (they say it "usually" covers the company's lifetime). So the features that compare daily history with the day's own prices line them up first (`dailyBasis`): the exact ratio of that day's 9:30 open in the 5-minute bars and the daily bar's open, or, without that day's bars, the fill against the daily open (or the close before) at the nearest of no split and the usual split ratios, allowing a day's 30% move. Nothing lines up: unknown, never a made-up number.
- **The all-time high** keeps no `{ high, date, through }` summary yet: the daily history is read whole on each run that needs it (one call per symbol). Worth adding if runs get slow.

### Worked examples

- **Volume run rate at entry:** volume from 9:30 to the entry bar over the average volume to that same time across the prior 20 sessions (volume is U-shaped, so a straight 'so far ÷ fraction of the day' makes every early entry look hot). Fills in for trades whose lookback days were saved.
- **Distance from the all-time high:** entry over the highest prior high (every prior day, plus today's before the entry), as a %. Needs daily bars back to the listing, which providers serve any time, so it stamps for the whole history at once. Only per symbol `{ high, date, through }` has to be kept. Needs split-adjusted prices (to be checked at Tradier; after a split the symbol's history is fetched again), and says 'high since 1998' when the provider's history starts after the listing.
- **SPY / QQQ over the daily 8 EMA at entry:** SPY's price at the entry bar against the daily 8 EMA updated with that price, so it never sees the day's close. Without SPY's 5-minute bars that day, the prior close against the prior EMA, flagged as such.
- **Entry over VWAP:** the underlying at the fill time against its session VWAP (for an option, the underlying's, not the option's).

## Part 3: the features page, filters and stats

- **Features page** (built in part 2, the Journal's Features tab): every feature with its name, what it measures, what it reads, its version, and how far it's stamped ('412 of 430, 18 unknown: bars too old, 3 to come'). Grouped by family. It's read from the feature list, so a new feature shows up there by itself. Search comes with the Conditions picker.
- **On the trade:** the trade page lists its stamped features (built in part 2: At entry); any can be a column in the trades list (part 3).
- **Conditions filter:** beside All setups, over Trades, Calendar and Stats. A searchable picker by family with pinned favorites; numbers take any threshold ('run rate ≥ 1.8'), words pick values. Conditions combine, and a combination can be saved as a named view.
- **Stats:** a feature explorer (pick any feature, see its breakdown with groupStats' numbers). Numbers group into five equal-size groups by default (quintiles), or the feature's own bins where given.
- **What matters (later):** features ranked by how much results differ between their groups. Test hundreds and some look meaningful by chance, so thin groups are dimmed, a pattern has to hold in both halves of the history, and it's a list of leads, not rules.

## Open questions

- Is Tradier's daily history split-adjusted, and how far back does it go for an old stock? The docs don't say either; the features line the history up with the day's own prices (see Splits above), so they're right either way. Worth one check against a real key (a stock that split, like NVDA in June 2024).
- Does Tradier serve VIX timesales?
- A provider with deep intraday history (Polygon / Massive, Alpaca) would fill intraday features further back than the 40 days saved now. Worth deciding once the features are in use.
