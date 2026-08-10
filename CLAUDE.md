# Size Calculator (index.html)

Single-file trade position sizing tool. No build step, no dependencies, no framework — one self-contained HTML file with vanilla JS. Keep it that way.

## What it does
Sizes shares and options positions off a dollar risk amount (account size × risk %), using Tradier's REST API directly from the browser (key stored in localStorage, never in the file).

## Architecture
- **Tradier API**: `api.tradier.com/v1` (or sandbox), Bearer auth. Endpoints used: `/markets/quotes` (greeks=true), `/markets/options/expirations`, `/markets/options/chains`, `/markets/timesales` (5min interval, for the chart)
- **Stops**: ONE global stop pair in the ticker card, used everywhere. Long stop (shares-long + calls, blank = LOD) and short stop (shares-short + puts, blank = HOD). Quick lookup uses the pair when its ticker matches the loaded quote, else that underlying's LOD/HOD. Inputs clear on symbol change. Chart click sets them side-aware: below current price = long, above = short
- **Shares mode** (default): Long/Short toggle. Shares = risk$ / |entry − stop|
- **Options mode**: straddle T-chart — calls left, strike center column, puts right, mirrored columns (Cts, Loss/ct, OI, Vol, Δ, Mid | Strike | reversed). Single-side views (Calls/Puts) use a wider layout with bid/ask/IV/@stop/total. Mobile (<500px) hides OI/Δ/bid/ask/IV/@stop and compacts number formats
- **Option loss model**: linear delta approx. `premium@stop = max(0, mid + delta × (stop − spot))`, loss/ct = (mid − premium@stop) × 100, contracts = floor(risk$ / loss per ct). Calls priced off the long stop, puts off the short stop
- **Reverse sizing**: Shares stat and Contracts stats (detail row, pinned cards) are editable inputs; committing a quantity writes risk$ back (riskForQty) and everything re-renders from it. Quantity floors use unitsFor (epsilon-tolerant) so counts round-trip exactly
- **Min |Δ| filter** (default 0.20): when set, shows ONLY OTM contracts with |delta| ≥ threshold (ITM hidden). Set to 0 = full chain
- **Loss/ct cells** show dollar loss with % of premium lost stacked below, color coded (green <25%, amber 25–60%, red >60%)
- **Vol/OI**: bold bright columns with blue tint; Vol turns amber when vol > OI (new positioning signal). This emphasis is intentional — don't tone it down
- **Expirations**: tabs, monthlies (third Friday, or Thursday-before if holiday) badged amber with "M" corner tag. Shows 12 + "+N more" expand
- **Quick lookup**: shorthand parser ("AAPL 245 6/20", "SPY 580 put 6/18/26") → OCC symbol → pinned result cards, newest on top
- **5-min chart**: canvas candlesticks (hand-rolled, no chart lib) at the bottom of the page. Walks back up to 6 sessions if today has no data. Dashed lines: HOD/LOD, amber long stop, teal short stop. Click = set stop (side-aware). Hover/touch-drag = OHLC crosshair
- **Keyboard shortcuts**: single keydown listener, ? shows the map. Keys ignored while typing in fields
- **Live mode**: ⚡ button polls quote + current chain every 5s for 60s, chart every ~20s, with countdown and overlap guards

## Conventions
- Dark trading-terminal theme, CSS variables in `:root`, monospace tabular numerals for all figures
- Big Shares/Options segmented switcher at top of ticker card — keep it prominent
- localStorage wrapped in try/catch (`store` helper) so sandboxed previews don't crash
- iOS home-screen meta tags present (apple-mobile-web-app-*) — file is meant to be hosted (GitHub Pages) and added to iPhone home screen
- Owner's style: direct, terse. No em dashes in user-facing copy.

## Known caveats / next ideas
- Delta approx ignores gamma/theta/IV shift — noted in detail rows, fine for intraday sizing
- `timesales` needs a Tradier brokerage-linked production key; chart hides quietly if unavailable
- If hosted-page CORS to api.tradier.com ever fails, fix is a small Cloudflare Worker proxy
- Possible future: stop-on-premium mode (vs stop-on-underlying), condensed mobile column set for <500px, OI static intraday (OCC settles overnight)

## Deploy
GitHub Pages, deploy-from-branch main /(root), file must be `index.html`.
