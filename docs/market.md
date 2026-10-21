# Market

The Market tab: theme tracker and ETF categories, live refresh, cached quotes and longer returns.

- **Market**: full-width view (`setView('market')`, key m) with five category tabs: Theme Tracker (146 industry groups / 2,860 stocks), Group ETFs (88), S&P Sectors (17), Equal Weight (13), Country ETFs (28).
  Two CSV snapshots in `data/` load together; partial load failures can be retried.
  Tabs have arrow/Home/End keyboard navigation.
  Table and heatmap share period/sort/search state; changing categories clears search/drilldown and keeps compatible periods.
  Theme rows use Today/1W/1M/3M/6M/YTD; ETFs use From open/Today/1W/1M/3M/6M/1Y, preserving the reference's Perf Year separately from YTD.
  Selecting a group drills into stocks; selecting any stock or ETF returns to sizing and clears old quote/stops.
  `/` searches, Escape returns from a group, r refreshes quotes for the active scope.
  `MarketData` is a pure inline script tested by `node --test`; no build/dependencies.
  Snapshot dates are explicit.
  Auto refresh defaults on with a configured key: active ETF category / opened group every 30 seconds, full Theme Tracker every three minutes after completion.
  Refresh quotes uses the same scope, preserves period/sort/search/table scroll/focus, commits atomically, and caches per scope and environment outside sync (v3, with v2 migration retaining timestamps).
  Cached quotes appear immediately with age/coverage/stale labels; a group can reuse a newer full-theme cache without making the overview appear fresh.
  One batched Tradier POST refresh runs at a time (100 symbols/batch, 1.25-second spacing); scope/view/visibility/offline changes cancel it.
  Failed batches retry twice with cancellable backoff, rate-limit headers are honored, exhausted failures back off 30 seconds–three minutes, and auth failures pause Auto.
  Auto off / Cancel pauses polling; Use snapshot also restores the imported data.
  Returning refreshes only stale scopes.
  Missing refreshed quotes become unavailable, never old-snapshot fallbacks.
  From open is `(last/open - 1) * 100`.
  Longer returns: an opened group and the ETF tabs read 1W–1Y from Tradier daily history (MarketData.historyRefs / withHistory / fetchHistories: the quote over the last close on or before the same calendar day back, YTD the prior year's last close, none for a close >10 days early; one symbol at a time, 0.6s apart, once a New York day, kept a week as market_history_v1_<env>; loading or missing = dash, never the snapshot); the full Theme Tracker overview keeps the Sep 16 snapshot (2,860 calls ≈ 25 min at Tradier's limit) and its headers say Sep 16 (marketPeriodLive).
  The stock CSV's exact 0 is missing data (parseCsv).
  Calculator charts and sticky bar stay hidden in Market, including pending quote callbacks, and calculator live polling pauses while Market is open.
  See `data/README.md` for sources, updates and validation.
