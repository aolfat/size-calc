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

**Refresh Today** requests all 3,006 stock and ETF symbols via Tradier's batch
quote endpoint in batches of 100 with 1.25 seconds between requests. The whole
refresh is committed after completion, including when the user switches tabs;
cancellation or failure preserves the previous data. Missing quotes become
unavailable, and group averages exclude them with a coverage marker. Quotes are
cached locally per API environment, outside encrypted position sync. The UI
shows the fetch time and environment. ETF From open is calculated as
`(last / open - 1) * 100`; an absent or invalid open stays unavailable. Longer
periods (1W–YTD for stocks, 1W–1Y for ETFs) remain imported values. The v2 quote
cache includes From open; older v1 caches are ignored.

To update the snapshots, add new stock/ETF CSVs and update `MARKET_FILE`,
`MARKET_ETF_FILE`, the initial download link, and visible dates in `index.html`.
Update the fixture paths and expected universe counts in the tests. Membership
does not automatically change when quotes refresh. Quote timestamps were not
provided by the reference tables; the capture time is not a pricing timestamp.

Run the data regression checks with `node --test`. Preview the app using any
static HTTP server from the repository root, for example
`python3 -m http.server 8000 --bind 127.0.0.1`. Open `/#market` to go directly to
the Market tab. No packages or build step are required.
