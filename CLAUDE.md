# Size Calculator

Trade position sizing tool.
No build step, no dependencies, no framework: `index.html` markup, `styles/*.css`, and native ES modules in `src/`, served as-is.
Keep it that way.
Two exceptions, both pinned in `vendor/`, committed and updated by hand, never loaded from a CDN, each with its version, sha256 and update steps in its header: Supabase's client library, `vendor/supabase.js` (supabase-js 2.117.3, the package's `dist/umd/supabase.js` wrapped as an ES module), loaded with `import()` only when signing in or when a session exists; and TradingView's Lightweight Charts, `vendor/lightweight-charts.js` (lightweight-charts 5.2.1, Apache-2.0, the package's `dist/lightweight-charts.standalone.production.mjs` unmodified under the header), loaded with `import()` (effects.loadChartLibrary) only when a Journal trade page draws a chart.
They sit outside `src/` on purpose (the test harness loads and scans every `src/` module).

## Code layout
- **Layers** (imports only point down): `src/core/` pure math and parsing, no DOM or state (bars, chart-view, black-scholes, options, sizing, stops, shorthand, futures, tos-statement, extended-hours, format, lev-etfs, market-data, orders, positions, cloud-merge; `core/features/` the trade features: one file per family plus the context and the stamping) → `src/lib/` store (guarded localStorage), media (DESKTOP_MQ / COMPACT_CHAIN_MQ, the SANS_FONT stack canvases draw with), delegate → `src/services/` tradier (base URL + headers, read from the settings inputs; dailyHistory, the ~1 year of daily bars both daily charts use), supabase (project URL + publishable key, the lazily loaded client, Google sign-in), bars (the journal's 5-minute bars: what's kept in bars_5m, the bar provider for what's missing), bar-source (where bars come from: barSource, Tradier's timesales and daily history for now, every provider answering in the app's own form), features (the trade_features stamps, the kept bars a stamping run reads, daily bars), cloud (the signed-in account's settings and Tradier key), schwab (tokens + Trader API via the Schwab worker); services never import UI → `src/ui/` one module per surface (risk, account-size, ticker, shares, chain, chart, daily, candles, cards, positions, position-chart, position-trade, market, tools, settings, trade, ...) → `src/main.js` boot.
  Each module's first line says what it owns
- **State**: all mutable app state is one object in `src/state.js` (`state.quoteData`, `state.currentMode`, ...); `createState()` lists every field with its default, `resetState()` restores them (tests).
  No loose globals: nothing is put on `window`
- **Events**: markup names an action, never an inline handler: `data-action` (click), `data-input`, `data-change`, `data-enter` (Enter keydown), with `data-arg` / `data-arg2` for arguments.
  `delegate(document, actions)` in main.js runs the nearest matching element's handler from the registry in `src/ui/actions.js`; rendered templates use the same attributes, so new cards and rows need no wiring.
  Adding a control = attribute in markup + one entry in `actions`.
  A test fails on any inline `on*` attribute or any action name without a handler (and vice versa)
- **Seams**: `onStoreWrite` (store tells the cloud module about value-changing writes, which marks account keys pending) and `onCloudView` (cloud reports status, rehydrate and pulled-toast to the settings sheet, which registers it on import).
  Side effects tests swap go through `effects` in `src/ui/effects.js` (copyPlainText, drawShareCard, shareCanvasToClipboard, openSim, reloadPage, wait, downloadText, prepareImage, readClipboardImages, loadChartLibrary): call `effects.x(...)`, not the import
- **Types**: `core/` and `lib/` are `// @ts-check` with JSDoc; `jsconfig.json` makes editors check them.
  Ad-hoc full check (TypeScript is not a dependency): `npx -p typescript tsc -p jsconfig.json`
- **Running**: ES modules do not load from `file://`; serve the folder (`npm run serve` = `python3 -m http.server 8765`) and open http://localhost:8765.
  Google sign-in works there too: Supabase's redirect list includes `http://localhost:8765/**`
- **Tests**: `node --test` (Node's built-in runner, no packages).
  `tests/helpers/app.mjs` loads the real modules against a small fake DOM built from every `id=` in index.html and in src templates; `app({ width, fetch, storage, timers, clock, supabase, session })` returns `run(code)`, which evaluates with every module export in scope and state fields readable and assignable as plain variables.
  `width` turns on matchMedia for the layout tiers; omit it for the plain single-column app.
  `supabase` is a fake client (tests/cloud.test.mjs has an in-memory one) and `session` signs it in; the real library never loads in tests.
  Neither does Lightweight Charts: every app gets a recording fake (tests/helpers/charts.mjs; `charts` passes your own, or a loader that throws) `tests/rls.test.mjs` reads `supabase/migrations/` and fails on any table without row-level security and an owner rule

## What it does
Sizes shares and options positions off a dollar risk amount (account size × risk %), using Tradier's REST API directly from the browser (key stored in localStorage, never in the file).
Account size and risk % persist in localStorage.
Risk $ (labelled "Max loss per trade") is styled as the loud number (big, bold, red — it's the max loss).
Risk % preset chips: .125/.25/.50/1/2/3%, plus fixed dollar chips (default 100/250/500/1000, editable via the ✎ chip → comma list, deduped, max 6, persisted as risk_usd_presets).
Active chips track whatever the current values resolve to — a $ tap can light its matching % chip too.
The amount per trade must stay ONE TAP away: the risk strip (#riskStrip) is one of the FIRST things on the page (owner request: the max loss frames the trade): top of the rail on desktop, first card under the header on phones, in every mode, after only the first-run setup notice.
It holds the risk $ input and both chip rows; the active chips tint red.
Its summary link (#riskStatus, '1% of $50,000'; allocation mode retitles the strip 'Allocation' and swaps in #allocationControls) opens #riskSheet, which only holds the slower settings: Risk / Allocation method, account size, risk %.
The strip shows in shares, options and futures, hidden in Positions, Tools and Market.
Keys - and = (or +) step risk through one ladder of every preset (riskLadder: % chips at this account size ∪ your $ chips; stepRisk, no-op in allocation).
There is no header risk pill (it was removed: two extra taps per change). risk_open is an orphan key from the old collapsible card.

## Where the details live
Each area's behavior is written down in its own file under `docs/`.
Read it before changing that area, and update it in the same PR when behavior changes.
- `docs/calculator.md`: the Size tab (Tradier, stops and stop strategies, ATR, shares and allocation sizing, the options chain and loss model, the simulator, quick lookup, verticals, the daily and intraday charts, live mode, extended hours)
- `docs/sync.md`: Google sign-in, settings sync, the Tradier key in Vault
- `docs/schwab.md`: the Schwab login and worker, Trade at Schwab, the banner, account size from Schwab, raw capture, the history download
- `docs/positions.md`: the Positions tab (rows, spreads, columns and R, position trades, the spread close, working orders, cancel, edit, the position chart and targets)
- `docs/journal.md`: the Journal tab (imports, trades, spreads, fees, reviews, bars, features, the trade page, the review deck, calendar and stats, the notebook)
- `docs/market.md`: the Market tab
- `docs/tools.md`: the top-level tabs and the Tools view
- Design notes and plans: `docs/journal-plan.md`, `docs/journal-step-1-supabase.md`, `docs/journal-step-2.md`, `docs/journal-step-3.md`, `docs/journal-features.md`, `docs/journal-notebook.md`; market data sources in `data/README.md`

## Writing these notes
One sentence per line, in CLAUDE.md and in the area docs: git merges line by line, so two branches adding sentences to the same area only collide when they touch the same sentence.
Add a new sentence on its own line instead of growing an existing one; a long bullet may break into paragraphs with a blank line before a **bold** lead-in.
Put a new area's notes in its own `docs/` file and add a pointer above.

## Conventions
- Dark trading-terminal theme, CSS variables in `:root`, tabular numerals for all figures.
  One font look everywhere (owner request, after a trade journal app they liked): Apple's system font (SF Pro, via -apple-system / BlinkMacSystemFont) on iPhone and Mac, and Inter, its open look-alike, everywhere else (`--sans`), self-hosted in `fonts/inter.woff2` (latin-subset variable woff2 from Google Fonts, 400–700, OFL in fonts/OFL.txt; not preloaded, so Apple devices never fetch it; missing glyphs like Δ and arrows fall back to the system font).
  Geist was the font before.
  Figures keep columns lined up through tabular digits, not a monospace: a universal `font-variant-numeric: tabular-nums !important` (the `font` shorthand would otherwise reset it).
  Figure styles use `--num` (= `--sans`; point it at `--mono` to bring back the monospace terminal look); `--mono` is the system monospace, only for the order payload JSON.
  Buttons and inputs inherit the family.
  Canvas text (charts, sim, share image) can't read CSS variables, so it uses SANS_FONT from `src/lib/media.js`; change both places together.
  Canvas has no tabular-digit switch, so canvas digits are proportional.
  Labels, section titles, and stat labels are sentence case (no tracked caps); dense table headers stay small caps.
  Helper copy is short sentences; longer rules go in a <details class="hint-details"> disclosure
- The shares answer is its own card (#sharesSection, class card) right after the ticket inputs, outside #quoteSection, so setQuoteVisible/updateModeSections drive its visibility.
  Shares sizing leads with an editable share count and equally prominent **Stop price**, followed by risk at stop, position value, and risk per share.
  Entry sits under shares; the stop source is **Custom stop** for an explicit input, otherwise **Low of day (LOD)** or **High of day (HOD)** according to direction.
  Never infer the source from price equality.
  Image and summary actions sit in the footer.
- Desktop shell (≥1100px, calculator and Positions only, media-only — no toggle): .app becomes a 100vh grid and the PAGE HOLDS STILL; each pane scrolls on its own (no position:sticky anywhere — sticky charts once shifted against the page; don't re-add).
  Panes: #sidePane = #railPane (setup notice, #riskStrip, ticket card #modeCard, shares answer, #optionTicket, futures) over #trayPane (quick lookup, pinned cards); #mainPane = kbd help, quote card, charts, chain (and the positions table in Positions, which spans the full width).
  Tools, Futures and Market scroll as a normal page at ≥1100 but keep the shell's full-width header at the same position and height (`.app > .header`), so switching views never moves the tabs; their content is a centered column (888px; Market 1468px). ≥1800px: #sidePane goes display:contents and the tray becomes its own right column (360 / 1fr / 340).
  Below 1100 every pane wrapper is display:contents and .app is a flex column, so the cards are flex items placed by `order` (setupNotice, riskStrip, modeCard, quoteCard, sharesSection / futuresSection, chartWrap, quick lookup, pinned, positions, then optionsSection).
  Chain tiers: COMPACT_CHAIN_MQ (1100–1439) keeps the compact columns (twoPaneChain(), isMobileChain() true, Δ/OI re-shown, colspans both 13 / single 8 / banner 6, charts stacked 5m first); ≥1440 the main pane is ~1000px so the full table returns (min-width dropped to fit, charts side by side).
  CSS mirrors DESKTOP_MQ / COMPACT_CHAIN_MQ exactly.
  On desktop, tapping a chain contract fills the rail ticket (#optionTicket via detailBody/showDetail, railDetailSym, re-armed on re-render, cleared by closeDetails) instead of an inline row; phones and tablets keep the inline detail row.
  ATM auto-scroll moves only the chain's own panel, centered on its on-screen slice. quoteSection is display:contents everywhere; its visibility uses style.display '' (never 'block')
- Keyboard help card is grouped (navigate / views / chain / data)
- Mobile rows (≤600px): preset chip rows (#riskPresets, #riskUsdRow) are single-line EQUAL-SPLIT thumb-sized chips (flex 1 1 0, 36px tall, labels hidden — % and $ speak for themselves; nowrap !important over .chip-row's default wrap; the desktop rail splits them the same way); #recentTickers stays side-swipe (unbounded list).
  Editing $ presets is in-place: ✎ turns each chip into a number box (blank = delete, trailing '+' box = add) and itself into ✓ to save (editingUsd state, Enter also saves); mobile quick-lookup parse preview sits on its own line under the input (the absolute in-field overlay overlapped the typed text at phone widths); ticker row is one line (#symbolField flexes, .field min-width 0, .btn-word spans hide → 'Load'/'↻'); Entry & stops = ONE row of tiles (direction switch, entry, stop; the Both view puts entry and both stops there), 46px tall, no $ prefix, no section title, ' · calls'/' · puts' label tails hidden, hint on its own line.
  The desktop rail keeps direction full-width with entry and stop two per row.
  Safe areas: .app and the sticky bar pad for the notch, toasts sit above the tab bar
- Daily chart toggle: 'D1' chip in the interval row AND the tappable 'Daily · tap to hide' label (.daily-toggle, truncates on narrow phones) both call toggleDaily (show_daily persisted); updateChartVisibility gates chartColD on showDaily, syncs the D1 active state, and repaints on re-show
- Card headers (pinned/spread): wide cards = one line, flex-wrap nowrap so the .pinned-meta shrinks/ellipsizes instead of splitting the .card-act cluster; mobile (<600px) and the narrow desktop columns (rail, tray) = identity line, full-width meta (keeps the editable stop visible), action row, badges hidden in rail/tray
- The chart card lives in #mainPane outside quoteSection; on phones it follows the quote and shares answer (the sticky bar carries the share count while you tap the chart to set stops); updateChartVisibility gates on positionsView since the card doesn't inherit quoteSection's hiding. drawChart skips a hidden canvas (it would wipe it to zero width) and setView repaints on the way back
- Page order = trade order: setup notice (only without a key), risk strip, ticket (instrument, ticker, entry and stops), quote bar, the answer, chart, quick lookup (collapsible, q expands), pinned cards, then the chain.
  Chart sits ABOVE the chain — levels before contracts.
  Setup never sits in the page: the header settings button (amber dot until a key exists) opens #settingsSheet (account, key, environment) and the risk strip's summary link opens #riskSheet.
  Sheets (openSheet/closeSheet) are a panel under the header on desktop and a bottom sheet on phones; missing-key actions call requireKey(), which toasts and opens Settings
- Sticky context bar (fixed, appears when scrolled past the quote card; never on the desktop shell since the page doesn't scroll): symbol, price/chg, share count in shares mode, LOD/HOD, ADR used %, risk $, chart/chain jump chips (jumpTo — smooth-scroll, offset by bar height), and a live chip (sbLive — start/extend/stop live from anywhere on the page, synced with the main button via syncSbLive; stopPropagation so it doesn't trigger the bar's back-to-top).
  Click elsewhere on the bar = back to top
- Stop inputs carry their chart line colors (red long stop, green short stop — a stop is a loss point, and it groups with the level it defaults to: LOD red, HOD green).
  Recalc-triggered re-renders pulse stat values (.pulse).
  Errors are fixed-position toasts, self-dismiss in 6s
- Big Shares / Options / Futures segmented switcher at top of ticker card — keep it prominent
- localStorage wrapped in try/catch (`store` helper) so sandboxed previews don't crash
- Content-Security-Policy meta in index.html, copied in `_headers` plus `frame-ancestors 'none'` (a test keeps them equal): `default-src 'self'`, no inline scripts, eval or other-origin scripts, styles self plus inline (style attributes), images self / data: / blob: / the Supabase project (signed screenshot links), no frames, objects or other-origin form posts; connect-src is any https (plus localhost) because the Schwab worker URL is user-configured.
  GitHub Pages ignores `_headers`, so main.js refuses to boot inside another site's frame (framedCrossOrigin: it empties the page).
  Tradier's answers reach markup unescaped in places, so they're checked where they come in: a quote's symbol must pass isSymbol (else the requested ticker), a chain keeps only contracts with an OCC symbol (isOccSymbol) and a numeric strike.
  Saved tag links pass cleanLink again when drawn
- PWA: manifest.json + icon-180/512.png + sw.js (network-first with cache: 'no-cache', so every open revalidates past the browser's HTTP cache, which GitHub Pages lets keep files 10 minutes; same-origin GETs only — API calls pass through; cached fallback offline).
  Registered only on https.
  Fixes iOS home-screen staleness — fresh version on every online open
- Durability: navigator.storage.persist() requested at init.
  The Export/Import backup file was removed by request; signing in is the way to carry settings across devices.
  Green toast variant: .error.ok via showToast()
- iOS home-screen meta tags present (apple-mobile-web-app-*) — file is meant to be hosted (GitHub Pages) and added to iPhone home screen.
  Status bar style is `black` (opaque, the page starts below it), not `black-translucent`: since iOS 26 a translucent status bar gets Liquid Glass's edge blur, which reached into the header and greyed it out even at the top; no CSS turns it off. iOS reads the style when the app is added, so an old install keeps the blur until it's removed and added again
- Wheel over a focused number input blurs it so the page scrolls instead of spinning the value
- Owner's style: direct, terse.
  No em dashes in user-facing copy.

## Known caveats / next ideas
- Loss model includes gamma but still ignores theta/IV shift — noted in detail rows, fine for intraday sizing
- Last ticker persists in localStorage and auto-loads on open when a key is saved
- `timesales` needs a Tradier brokerage-linked production key; chart hides quietly if unavailable
- If hosted-page CORS to api.tradier.com ever fails, fix is a small Cloudflare Worker proxy
- Possible future: stop-on-premium mode (vs stop-on-underlying), condensed mobile column set for <500px, OI static intraday (OCC settles overnight)

## Deploy
The app lives on GitHub Pages (https://aolfat.github.io/size-calc/), where sign-in, API keys and Schwab work.
Credentials need HTTPS or localhost (`src/lib/credential-origin.js`); any other address clears old credentials on load and disables entry. github.io was briefly blocked too (every Pages site under the account shares the origin's storage) and allowed again by request.
The only other Pages site there, aolfat.github.io/resume, runs no scripts: any script on any aolfat.github.io page could read the Tradier key, the Google session and the Schwab tokens, so keep it that way.
`worker/app/wrangler.toml` can serve the same app on its own `workers.dev` origin if that ever changes; `worker/app/README.md` lists the Supabase and Schwab callback changes that move needs.
`.assetsignore` limits deployment to browser runtime files, and `_headers` supplies security headers.
The shared Schwab worker remains in use; its operator can access tokens in transit, and the Supabase administrator can decrypt synced Tradier keys.
Settings discloses both.
The entry page must be `index.html` at the root; `styles/`, `src/`, `fonts/` and `data/` deploy beside it as plain files.
The Schwab worker deploys separately with wrangler (`worker/schwab/README.md`).
Database changes are SQL files in `supabase/migrations/`, applied with `npx supabase db push` after `npx supabase link --project-ref dhohfavttsxwutanvcuj` (it asks for the database password; never commit it).
The schema is one baseline, `20261018000000_baseline.sql` (the step 1 and 2 migrations squashed; safe to run over any older state: tables if not exists, functions and triggers replaced, policies dropped and made again, an up-to-date section for older databases); tests/rls.test.mjs keeps it one file and checks every synced setting is a key the settings table accepts.
Later changes go in new files after it.
`vendor/` deploys beside `src/`.
