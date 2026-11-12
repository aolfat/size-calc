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
  Auto refresh defaults on with a configured key: active ETF category / opened group every 10 seconds, full Theme Tracker every minute after completion (owner request: faster, and not only when Market is opened).
  Once Market has loaded in a session, its last scope keeps refreshing from the other tabs every two minutes (MARKET_BACKGROUND_MS, batches 2 seconds apart to leave room for the calculator's live polling), so Market is current on the way back; daily history loads only in Market (owner request), and a hidden app or no network stops both.
  Refresh quotes uses the same scope, preserves period/sort/search/table scroll/focus, and caches per scope and environment outside sync (v3, with v2 migration retaining timestamps).
  A scope that already has quotes shows each batch as it lands (the overview is 29 batches); the rest keep their previous quotes, the fetched time moves only when the last batch lands, and a failure or cancel puts the previous snapshot back.
  A first refresh, with nothing to show yet, commits at once at the end.
  Cached quotes appear immediately with age/coverage/stale labels; a group can reuse a newer full-theme cache without making the overview appear fresh.
  One batched Tradier POST refresh runs at a time (100 symbols/batch, 0.6 seconds apart in Market, 1.1 in the sandbox, 2 from other tabs); scope/visibility/offline changes cancel it, leaving Market does not.
  Failed batches retry twice with cancellable backoff, rate-limit headers are honored, exhausted failures back off 30 seconds–three minutes, and auth failures pause Auto.
  Auto off / Cancel pauses polling; Use snapshot also restores the imported data.
  Returning refreshes only stale scopes.
  Missing refreshed quotes become unavailable, never old-snapshot fallbacks.
  From open is `(last/open - 1) * 100`.
  Longer returns: every scope (the Theme Tracker overview, an opened group, the ETF tabs) reads 1W–1Y from daily history (MarketData.historyRefs / withHistory / fetchHistories: the quote over the last close on or before the same calendar day back, YTD the prior year's last close, none for a close >10 days early; one symbol at a time, 0.6s apart, 1.1 in the sandbox; kept a week as market_history_v1_<env>; loading or missing = dash, never the snapshot).
  The overview used to keep the Sep 16 snapshot for them, so its 1W and 1M went stale while Today refreshed (owner report); now it reads every stock's closes, about half an hour of reads in Market the first time each day.
  History is read once a New York session day (MarketData.historyDay: a weekend reads Friday's, so it loads nothing again), and saved every 5 symbols as it lands and again whenever a load stops (leaving Market, a hidden app), so coming back or a reload reads only what's still missing and yesterday's references show until today's land.
  Every reference is an earlier close, so a read ends the day before (a Schwab read then needs no extra quote for today's bar).
  Opening a group while the overview loads reads that group's stocks first; coming back resumes the rest.
  Headers say Sep 16 only in snapshot mode or before any quotes (marketPeriodLive).
  The stock CSV's exact 0 is missing data (parseCsv).
  Calculator charts and sticky bar stay hidden in Market, including pending quote callbacks, and calculator live polling pauses while Market is open.
  See `data/README.md` for sources, updates and validation.
