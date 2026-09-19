# Market universe

`market-universe-2026-09-16.csv` is an unmodified snapshot downloaded through
Market Theme Tracker's signed-in **Download universe (CSV)** control.

- Source: https://market-theme-tracker.replit.app/api/stocks/export.csv
- Source filename: `universe-2026-09-16.csv`
- Coverage: 2,860 unique tickers across 146 industry groups.
- Mapping columns: `ticker`, `name`, `group`.
- Validation: no duplicate tickers or missing ticker, name, or group values.

The six performance columns are source snapshot values, not a live price feed.
The export does not include a per-row price timestamp. Use the mapping columns
to seed the Market page and obtain fresh prices separately. Group membership
will also need periodic review as symbols and listings change.

`market-etfs-2026-09-16.csv` contains the rendered ETF table data captured from
the same site's four Market Pulse tabs on **2026-09-16 at 01:27 UTC**:

| Tab | Category key | Funds |
| --- | --- | ---: |
| Group ETFs | `group-etfs` | 88 |
| S&P Sectors | `sectors` | 17 |
| Equal Weight | `equal-weight` | 13 |
| Country ETFs | `countries` | 28 |

All 146 ETF symbols are distinct, and none overlap with the stock universe.
These are the site's actual lists, including growth/value funds in S&P Sectors
and regional/global funds in Country ETFs. They were read from the visible
tables, not inferred from fund names. The ETF CSV preserves the displayed
two-decimal values, with source `-` cells stored as blanks. It maps Perf Day,
Week, Month, 3M, 6M and Year to Today, 1W, 1M, 3M, 6M and 1Y. The additional
`performance_open` field is Change from Open. ETF `performance_ytd` is blank;
the source's Perf Year is kept separately in `performance_1y`.

The Market tab loads both CSVs on first open, with a retry if either fails.
Its five tabs offer equal-weight industry
averages, a sortable table, a heatmap, and ticker/company/group search. Searching
for a ticker in Groups keeps the complete group's average. Selecting a ticker
opens the sizing calculator and loads its quote with the existing Tradier key.
ETF categories use their own constituent lists and performance columns. Switching
categories clears search and group drilldown, while keeping display and a valid
period selection. Tabs support arrow keys, Home and End. Tables sort by ticker
or any performance column in either direction. The ETF download includes all
four ETF categories; the stock download is the unmodified original export.

**Auto** is on by default when a Tradier key is configured. Refreshes cover only
the active ETF category or opened industry group every 30 seconds. The complete
Theme Tracker overview (Groups or all Stocks) refreshes its 2,860 stocks every
three minutes. These intervals start when a refresh completes. Search filters
do not reduce the quote universe, so group averages keep their full membership.
**Refresh quotes** requests the same active scope immediately, subject to any
failure cooldown. The selected period, sort, search, table scroll and keyboard
focus are preserved when quotes arrive.

Cached quotes display immediately, with their fetch age, environment, coverage
and a stale label once the scope's interval has elapsed. Each category and
opened group has its own cache and timestamp. Groups can reuse newer full-theme
quotes; refreshing one group never marks the full overview fresh. Caches use
`market_quotes_v3_<environment>` in local storage, outside encrypted position
sync. Existing v2 caches are read into scopes with their original timestamps;
v1 caches are ignored. The Auto preference is also local to this browser.

Requests use Tradier's POST quote endpoint in batches of 100, with 1.25 seconds
between batches and at most one refresh in flight. Leaving Market, hiding the
browser tab, going offline or changing scope cancels unnecessary requests.
Returning reuses fresh cached data and refreshes only when stale. Turning Auto
off or pressing Cancel pauses automatic requests. **Use snapshot** also pauses
Auto and displays the imported CSV values. Turning Auto on restores cached
quotes and resumes the schedule.

Network errors, timeouts, HTTP 429 and server errors retry only the failed batch
up to twice. Rate limits honor Retry-After or X-Ratelimit-Expiry when available,
otherwise waiting a minute. Exhausted retries keep the previous complete scope
and back off subsequent attempts from 30 seconds to three minutes. Invalid
credentials pause Auto until the key/environment changes or the user retries.
Only a completed scope replaces its cache; cancellations and failures preserve
the previous data. Missing quotes become unavailable, and group averages
exclude them with a coverage marker.

ETF From open is calculated as `(last / open - 1) * 100`; an absent or invalid
open stays unavailable. Longer periods (1W–YTD for stocks, 1W–1Y for ETFs) remain
explicitly labeled imported values. Fetch age is not an exchange timestamp, and
provider prices may be delayed. Historical-price ingestion remains a future
backend concern; no server or new data service is required for these refreshes.

To update the snapshots, add new stock/ETF CSVs and update `MARKET_FILE`,
`MARKET_ETF_FILE`, the initial download link, and visible dates in `index.html`.
Update the fixture paths and expected universe counts in the tests. Membership
does not automatically change when quotes refresh. Quote timestamps were not
provided by the reference tables; the capture time is not a pricing timestamp.

Run the data regression checks with `node --test`. Preview the app using any
static HTTP server from the repository root, for example
`python3 -m http.server 8000 --bind 127.0.0.1`. Open `/#market` to go directly to
the Market tab. No packages or build step are required.
