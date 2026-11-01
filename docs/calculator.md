# The Size tab

How the calculator works: Tradier, stops and stop strategies, ATR, shares and allocation sizing, the options chain and its loss model, the simulator, quick lookup, verticals, both charts, live mode and extended hours.

- **Tradier API**: `api.tradier.com/v1` (or sandbox), Bearer auth.
  Endpoints used: `/markets/quotes` (greeks=true), `/markets/options/expirations`, `/markets/options/chains`, `/markets/timesales` (5min interval, for the chart)
- **Stops**: ONE global stop pair in the ticker card, used everywhere.
  Long stop (shares-long + calls, blank = LOD) and short stop (shares-short + puts, blank = HOD).
  Only the stop matching tradeCtx() is shown/drawn (shares follow the Long/Short toggle, options follow chain side; Both view shows both).
  Chart click sets the context's stop; in Both view, below price = long, above = short.
  Quick lookup uses the pair when its ticker matches the loaded quote, else that underlying's LOD/HOD.
  Inputs clear on symbol change.
  Only an explicit Load (fetchQuote) reads the ticker field, which doubles as the search box; every refresh (refreshQuote, live ticks, mode switch, expiry, chart interval) keys off `state.quoteData.symbol`, so typed-but-unloaded text never swaps the quote under the old stops.
  Symbols must match isSymbol (ticker.js) before they're fetched or saved, and are URL-encoded and escaped everywhere
- **Stop adjustment strategies**: selector below the stop inputs offers None (default), 5m ATR, and Percentage.
  While an adjustment is on, an **Off** button beside the selector (stopAdjustmentOff) sets it back to None in one tap.
  ATR keeps its 0.25× / 0.5× / 1× / 1.5× / 2× chips.
  Percentage offers 0.025 / 0.05 / 0.1 / 0.25 / 0.5% presets plus a custom input (0 ≤ percent < 100).
  The percentage is of the LOD/HOD price, not entry-to-stop distance: long stop = LOD × (1 − percent / 100), short stop = HOD × (1 + percent / 100).
  Each strategy remembers its amount; None retains both.
  `stop_strategy`, `stop_percent`, and `atr_multiplier` participate in sync.
  Existing ATR-only settings restore as ATR when nonzero, otherwise None.
  Manual/chart-set stops override either strategy.
  Nonzero buffers round outward to cents and feed shares, reverse sizing, option estimates, copy/image output, both charts and their click mappings.
  Invalid inputs or nonpositive stops block automatic sizing.
  Percentage works without ATR data; quick lookup for another ticker only fetches ATR when the ATR strategy is selected.
  Pinned buffered stops are labeled fixed and retain their numeric price on refresh; unadjusted LOD/HOD cards retain live-level behavior.
  Presets are experiments, not backtested recommendations; price adjustments cannot confirm a 5m close.
  Tests: `node --test`.
- **Five-minute ATR calculation**: long stops use LOD minus multiplier × ATR(14); shorts use HOD plus the buffer.
  ATR uses regular-session native 5m bars, 14 true ranges seeded with a simple average then Wilder smoothing, including gaps from the previous session.
  With Ext on, the extended bars are filtered out (regularBar: 9:30 to 16:00) before the ATR, so thin overnight bars never widen the buffer.
  API epoch timestamps exclude incomplete bars.
  A fixed 14-calendar-day fetch keeps the seed independent of the visible 5/15/30/65m chart interval.
  The readout includes the last completed bar's date/time.
  Missing ATR blocks automatic sizing only for the ATR strategy.
  Formula reference: https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/atr; candle timestamps: https://docs.tradier.com/docs/timesale
- **Shares mode** (default): Shares = risk$ / |entry − stop|.
  The Long/Short toggle lives FIRST in the Entry & stops row (direction is the first decision; dirField hidden in options mode where chain side plays that role)
- **Futures in Stocks & futures** (the Shares mode, renamed; there is no Futures tab): a ticker starting with / loads a futures contract (ui/futures.js, core/futures.js).
  futuresSymbol takes a root FUTURES_CONTRACTS knows (/MES, the active contract) or one month (/MESZ26); any other / ticker says which roots work.
  Everything comes from Schwab's market data through the worker (Tradier has no futures), so it needs a Schwab login; without one the box says so and reads nothing.
  The quote (`/marketdata/v1/quotes`, schwabFuturesQuote) becomes the app's quote form (parseFuturesQuote: type 'future', symbol as typed, contract the month Schwab answered with, the ticket's tick size and value); a zero price is none, a crossed bid and ask no market.
  The quote bar shows the contract, prices on the tick's decimals (fmtTicks), and Real-time or Delayed from Schwab's realtime flag; there is no extended-hours price for futures.
  The 5-minute chart reads 8 days of `/marketdata/v1/pricehistory` 5-minute candles, overnight included (schwabFuturesBars, futuresBars), and the daily chart a year of daily candles (futuresDays).
  Bars carry their CME trading day: from 18:00 New York a bar belongs to the next day's session (futuresSessionClock), so the 5-minute view shows today's session from the evening open, and prior-day levels and ADR read whole sessions.
  Until the new session has 24 bars (two hours, so about 20:00), the 5-minute view keeps the session before it on screen too.
  Chart price labels for futures use the tick's decimals and no $ (priceLabeler).
  The Ext chip changes nothing for futures: their bars always run overnight, and the default LOD / HOD stay Schwab's session's.
  The sticky bar shows the price on the tick and the count as ct.
  ATR reads those bars, overnight ones included.
  Sizing is the shares card counting contracts: futuresPlan puts the entry on the nearest tick and the stop on the tick past it, away from the entry (a chart click or a buffer can land between ticks), then contracts = risk$ / (ticks × tick value + round-trip fees), floored.
  sharesPlan answers it in the shares form (shares = contracts, riskPerShare = risk per contract), so reverse sizing, the sticky bar and Live work unchanged.
  The card shows contracts, the month and entry, the stop and its source, risk at stop, risk per contract (ticks × tick value + fees), notional and the dollars a point.
  Round-trip fees per contract are typed in the card and kept per root on this device (futures_fees).
  A delayed quote, a Schwab tick that disagrees with FUTURES_CONTRACTS, or a max loss below one contract is said in amber.
  Futures size by risk only (loading one switches allocation back); Trade at Schwab, the image card and the opening range are hidden; Options says there are no futures chains here.
  Copy summary names the month ('Short 11 /MESZ26 contracts @ …').
  Live polls the Schwab quote each tick and the chart every fourth.
  A worker from before the market data relay answers 404 (redeploy it), a Schwab app without Market Data Production 401 or 403; the toast says which.
  The last ticker reloads at boot only when its source is there (a Schwab login for futures).
- **Allocation sizing**: Risk remains the default on load.
  Allocation uses `floor((account × allocation% − existing exposure) / unit cost)`, floored at zero.
  Long shares use planned entry (current quote if blank), long options use full mid debit × 100, and explicitly selected **Sell put** uses strike × 100.
  Target allocation % is persisted/synced as `calc_allocation`; manual existing exposure is session-only and keyed by ticker (shares at current value + short-put assignment notional + long-option debit).
  Total allocation includes existing exposure.
  Editable quantities change allocation %, leaving risk settings intact.
  Futures tickers and short shares switch to Risk; spreads keep defined-risk sizing.
  Allocation ignores chart stops.
  Switching away from Options clears sell intent.
- **Allocation option cards**: chain detail can pin a trade; quick lookup captures the current sizing mode and buy/sell choice before fetching.
  Cards retain `sizing:'allocation'`, `shortPut`, and `credit` after global mode changes.
  Only verified stock/ETF underlyings, matching standard roots, and 100-share contracts are supported; invalid/crossed/missing/zero-bid quotes and expired contracts cannot size a new trade.
  Missing Greeks do not block sizing.
  The put panel shows assignment notional, premium, basis/breakeven, maximum loss at zero, and return on full notional; simple annualization is unavailable at zero DTE.
  DTE uses the New York calendar.
  Exposure remains manual.
  Copy, image, and simulation preserve side; short-put simulation returns use strike notional.
  No broker BP estimate, 50%-capital return, return/delta score, or assigned-call preview in v1.
- **Options mode**: straddle T-chart — calls left, strike center column, puts right, mirrored columns (Cts, Loss/ct, OI, Vol, Δ, Mid | Strike | reversed).
  Single-side views (Calls/Puts) use a wider layout with bid/ask/IV/@stop/total.
  Mobile (<500px) shows OI/Vol/Δ/Mid per side (m-size hides Loss/Cts/Total — sizing lives in the tap-in detail; m-oi and m-delta re-shown) and compacts number formats; colspans both 9 / single 5 / banner 4.
  Chain header is locked while scrolling: sticky thead — on desktop the chain is its own scroll panel (.chain-scroll, max-height ~100vh); on mobile (table fits, no scroll wrapper) it sticks to the page below the context bar (--sbh offset)
- **Share cards**: the shares sizing card has separate **Copy card image** and **Copy summary** actions, disabled when the stop is invalid.
  Image copying (also available as 'share' on pinned cards) renders a hand-drawn canvas PNG (drawShareCard — deliberately NOT a DOM screenshot: no deps, Safari foreignObject is unreliable) via ClipboardItem (promise constructed inside the gesture for Safari); falls back to downloading the PNG.
  Shares images label custom stops explicitly and retain percentage-based risk/position values and the $10k-account example.
  Copy-as-text one-liners (copyShares/copyPinned) state risk as % of account and end with a $100-risk example (ex100: units for $100, or the one-unit risk when a single unit exceeds it)
- **Simulate returns**: Black-Scholes (normCdf via Abramowitz-Stegun, RISK_FREE 4%) canvas modal — return % over time (now → expiry) at a slider-chosen underlying price, IV held constant.
  Green above breakeven / red below via canvas clipping, max-loss floor, drag crosshair readout (est $/ct, %, $ P&L × qty).
  Price chips: stop / now / 1R / 2R (R = distance to stop, side-aware), or −1σ / now / +1σ when opened from a position (#simRChips / #simEmChips).
  Entry points: chain detail row (simReg by OCC symbol), pinned cards (entry = mid), option positions (entry = your average cost).
  Esc closes
- **Option loss model**: Black-Scholes move applied to the market mid — `premium@stop = max(0, mid + BS(stop,T) − BS(spot,T))` so IV-skew level offsets cancel; time to expiry runs to the 4pm New York close (expiryCloseMs in core/options.js, whatever the device's zone; also the sim and the allocation expired check); falls back to Δ+½Γ·move² when the contract has no IV (model flag 'bs'/'approx').
  Clamped so a loss-direction move can't show a gain. loss/ct = (mid − premium@stop) × 100, contracts = floor(risk$ / loss per ct).
  Calls priced off the long stop, puts off the short stop.
  Mid cells flag wide spreads (>10% of mid) in amber
- **Overnight line**: every loss@stop also computes premium@stop at T − 1 day (atStopON/atLodON).
  Detail rows and cards show a quiet 'held overnight: −$X (−Y%)' line when it's worse than today's — no controls; 0DTE naturally shows full loss to intrinsic
- **Expected move**: ATM straddle mid for the loaded expiry, shown in the filter row (emInfo), computed pre-zone-filter
- **IV percentile**: ivInfo in the filter row shows the loaded expiry's ATM IV ranked against the past year's rolling HV20 distribution (hvDist, from the 380-day history fetch).
  Amber ≥80th (rich), green ≤20th (cheap).
  True IV Rank isn't available from Tradier (no historical IV endpoint); an own-IV diary was tried and removed by request
- **HV20 + prior day**: fetchAdr's daily history also yields hv20 (annualized 20d stdev of log returns) and prevDay {h,l,c}.
  Detail rows show IV vs HV20 (amber >1.5×).
  Chart draws PDH/PDL/PDC gray dashed lines when inside the visible range
- **Recent tickers**: last 5 symbols as chips under the symbol row (recent_tickers, MRU, current excluded).
  Chain auto-scrolls to the ATM row on user-driven loads only (pendingAtmScroll — never on live polls).
  Live mode is a duration ladder: tap ⚡ for 1m @ 5s ticks, tap again to extend 5m @ 10s, again 30m @ 20s, again stops (LIVE_MODES).
  Refreshes pinned cards every 4th tick offset from the chart.
  Backgrounding PAUSES the session (remaining time kept) and returning resumes it
- **Reverse sizing**: Shares stat and Contracts stats (detail row, pinned cards) are editable inputs; committing a quantity writes risk$ back (riskForQty) and everything re-renders from it.
  Quantity floors use unitsFor (epsilon-tolerant) so counts round-trip exactly
- **Zone filter deltas**: filtering uses a BS-computed delta (filterDelta — Tradier greeks can print flat 1.000 across all ITM strikes, defeating any threshold); the Δ column still displays the API value
- **Zone filter**: radio segmented control (setZoneMode: otm | itm | both | all → sets zoneFilter) — OTM (|Δ| ≥ .20 floor), ITM→ATM (a DEPTH LIMIT: |Δ| ≤ setting, default .80, band runs from the ATM strike down to it; ATM strike always shows with a blue ATM badge; deeper = All view), Both (union → contiguous band around ATM), All (no filter).
  One mode at a time; each Δ floor input only visible when its zone is active.
  Keys 1/2/3/4.
  ATM strike computed from the full chain pre-filter.
  Zones apply ONLY to single-side views.
  The Both-sides T-chart ignores them entirely and instead shows a configurable window of ± N strikes around ATM (bothStrikes input, default 8, persisted as both_strikes; zone seg + floors hidden there via updateChainControls).
  Any zone pick (chip or keys 1–4) from Both view switches to Calls first; the chosen zone mode is remembered across side switches
- **Entry price**: optional underlying entry input (blank = current price) in the Entry & stops row, amber border/line (blue collided with VWAP).
  Shares size off |entry − stop|; chain prices premium@entry via the same BS move and losses run entry→stop (entryPrem is the cost basis for cts/total/loss%).
  Drawn on both charts, cleared on symbol change; sim uses entryPrem
- **Opening range** (ui/orb.js, #orbRow under Entry & stops; shares on risk sizing only, like Trade at Schwab): 5m / 15m / 30m chips read today's 5-minute bars fresh from Tradier (fetchFiveMinuteBars; the range may have closed since the chart loaded) and take the high and low from 9:30 to 9:35, 9:45 or 10:00 ET (openingRange in core/bars.js, pure).
  A long's entry goes a tick over the high with its stop at the low, a short's a tick under the low with its stop at the high (orbLevels: a cent, $0.0001 under $1), written into the Entry and stop inputs, so sizing and the chart work as if typed.
  Its times read in the Settings zone (docs/time-zone.md): 'The 15m range closes at 6:45 PT.' in PT, the window itself still New York's.
  Refused with a line under the chips (state.orbNote): before the range closes ('The 15m range closes at 9:45 ET.'), when its last bar isn't in yet and no later one is (allowed five minutes on, since a thin stock may not trade every bar), with no bars from today's open, or when Tradier won't send bars (they need a brokerage-linked key).
  state.orb remembers what the chip set; while the ticket still holds it (same symbol, direction, entry and stop) the chip stays lit, the line says the range, and the card names the entry '15m range high' and the stop '15m range low' instead of planned and Custom stop.
  Changing either input, the direction or the ticker makes them yours again.
- **Loss/ct cells** show dollar loss with % of premium lost stacked below, color coded (green <25%, amber 25–60%, red >60%)
- **Vol/OI**: bold columns with blue tint, resting in muted gold (--gold #d9b968); BOTH turn full amber together when vol > OI (the signal is about the pair — they're always read together).
  This emphasis is intentional — don't tone it down
- **Expirations**: tabs with a DTE line under each date, monthlies (third Friday, or Thursday-before only when that Friday is an NYSE holiday: Good Friday or Juneteenth) badged amber with "M" corner tag.
  DTE counts to 4pm New York on expiry (expiryCloseMs), wherever you are; Tradier's dates go into markup, so any that isn't YYYY-MM-DD is dropped where they come in (cleanExpirations).
  Shows 12 + "+N more" expand
- **Quick lookup**: the ticker field is ALSO the search box: submitTicker routes a single word to fetchQuote and anything with spaces to fetchQuickOption(text, fromSearch) — which pins the card, puts the loaded symbol back in the field, and scrolls the new card into view on phones. #tickerParsed under the field previews the pin ('Pin AAPL $245 call …'), says what's missing, or shows the shorthand hint.
  On phones the separate Quick lookup card is hidden (the field does it); desktop and tablet keep it.
  Order-free shorthand parser — tokens classified by shape (ticker / strike / date / call-put, and a strike may carry its type: 245c, 580.5p), any order, `/` or `.` date separators ("AAPL 245 6/20", "9.18 300 aapl", "SPY 580 put 6/18/26") → OCC symbol → pinned result cards, newest on top.
  Dotted number = date unless a date is already set or it can't be a calendar day like 9.31 (then strike); impossible dates (9/31, 2/30) are rejected, a month/day already passed in New York rolls to next year, and an unexplained extra number makes it ambiguous (quickParseHint says why, in #tickerParsed and the error toast); bare c/p = type only when another word can be the ticker.
  Spread shorthand: a slashed strike pair (105/115 — anything slashed that can't be a date) or two bare numbers plus cds/pds/ccs/pcs ('rbrk 105/115 8/28 cds') → spread pinned card; second letter d = debit, c = credit.
  Near strike first either way: calls take the lower, puts the higher (debit buys it, credit sells it); both legs fetched in one quotes call, a pair whose near mid isn't the richer rejected.
  A pair without a spread token parses as '?'
- **Verticals — debit and credit spreads** (two-leg, the only multi-leg supported): '+ debit spread' / '+ credit spread' in a single-side detail row marks the near leg (detailReg by OCC symbol), a banner asks for the far strike (calls higher, puts lower, both kinds), tapping a row completes it (direction and net > 0 validated; Esc or side/mode/chain changes cancel via cancelSpread).
  Spread cards are pinnedData entries with kind:'spread' + legs[{K,iv,side,occ,mid,delta}]; legs are ALWAYS the debit-spread legs (near +1, far −1) and d.mid = their net (= the debit paid, or the credit received) — a credit spread is just credit:true on top, i.e. SHORT that debit spread. cardValueAt(d,S,T) nets the legs' BS values and recalcPinnedStop/sim math all run through it, so stop-value, overnight, P&L, and the simulator (legs-aware simCurve) just work; refreshCardData is untouched by credit.
  The credit flag only flips signs and words at the edges: isBull(d) picks the stop side (call credit = bearish → HOD/short stop) and the losing direction, recalcPinnedStop clamps the other way (a loss move can't get cheaper to buy back) and caps spread value at width, loss/ct = close@stop − credit, lossOfCost = % of max loss.
  SIZED BY DEFINED RISK (sizeUnit(d)): full debit, or width − credit.
  Sim return % basis for credit = max loss, so the −100% floor and full-credit max profit fall out naturally; 1R/2R chips and sim direction follow isBull.
  Debit card leads with max profit; the credit card instead shows an always-visible Max loss / spread stat (max profit = the credit = stat 1) and the credit as % of width (on the pinned stat and share image).
  Breakeven (near K ± net, same formula both kinds), reward/risk; direction tag color follows isBull.
  Share/copy label as '100/110c debit spread' / 'sold … credit spread'
- **Daily chart**: second canvas pane LEFT of the 5-min when side-by-side; when STACKED (<700px and the compact desktop tier, 1100–1439) the 5-min working chart leads and daily sits below (#chartCol5 order:-1), a window onto the ADR history fetch (~260 sessions incl. today's forming bar), candles + daily 8 EMA + the context's stop lines.
  The window: range chips 1M / 3M / 6M / 1Y (21 / 63 / 126 / 252 sessions, default 3M, persisted as daily_range, device-local like show_daily) next to the 'Daily' label; pinch (touch, trackpad as ctrl+wheel, Safari gesture events) or ctrl/cmd+scroll zooms around the cursor, mouse drag / one-finger sideways swipe / horizontal trackpad swipe / shift+scroll pans; plain vertical scroll and vertical swipes still move the page. dailyView {count, offset} counts back from today (core/chart-view.js: clampView, viewRange, zoomView, panView; fractional so small steps add up; 10-bar floor).
  A chip lights only while the view shows exactly that range (none after a gesture zoom); tapping it resets to today.
  Panned back, a 'Today →' chip sits in the plot's bottom-right corner (not the caption: no room on phones).
  The view resets to the chosen range on a new symbol (dailySymbol), not on a reload of the same one.
  The price scale fits the VISIBLE bars plus stop/entry lines; the EMA is warmed up on the full history and clipped to the plot. dailyGeom(w) is the one scale for drawing, hover and click-to-stop (dailyPriceAtY).
  Scale, painting and gestures live in ui/candles.js (candleGeom, paintCandles, attachCandleGestures), shared with the position chart; line labels draw over the candles on a backing.
  A mouse drag never sets a stop; touch gestures go through attachTouchCrosshair's optional gestures hooks (a second finger cancels the long-press there, on every chart).
  Click sets a stop (setStopFromPrice, shared with 5-min); hover = full crosshair (vertical bar line + horizontal price line with axis tag, like the 5-min and sim charts) and shares the OHLC readout with a '1D' prefix.
  Chart card shows whichever panes have data (updateChartVisibility) — daily works without a brokerage-linked key even when timesales doesn't
- **Intraday chart**: canvas candlesticks (hand-rolled, no chart lib) directly under the quote bar.
  Interval chips 5m/15m/30m/65m (chartInterval, persisted): 5m native from timesales, larger intervals aggregated client-side from 5m, bucketed by clock time from the 9:30 open so a missing 5m bar can't shift later buckets (buckets never cross a session), with more lookback per interval (CHART_SESSIONS 1/2/3/5).
  VWAP resets per session; HOD/LOD dashed lines come from the LAST session only; faint separators at session boundaries.
  Walks back up to 6 sessions if today has no data.
  Dashed lines: HOD/LOD, red long stop, green short stop.
  Overlays: blue VWAP, purple 8 EMA.
  Click/tap = set stop (side-aware).
  Touch: LONG-PRESS (~220ms hold) engages the crosshair via attachTouchCrosshair — the chart owns the gesture (preventDefault, page holds still), and RELEASING SETS THE STOP at the final crosshair price (onEnd gets the last point; the trailing click is suppressed so it can't double-fire; sim chart release is read-only).
  Quick swipes scroll the page normally, plain taps still set stops.
  Mouse hover = full crosshair (vertical bar line + horizontal price line with axis tag) + OHLC readout.
  Chart header shows ADR14 (from `/markets/history` daily bars, today excluded) as $ and % of price, plus % of the ADR consumed from the trade's reference level — LOD when long, HOD when short (shares follow the direction toggle, options follow chain side, Both shows both); amber at ≥90% consumed
- **Keyboard shortcuts**: single keydown listener, ? shows the map.
  Keys ignored while typing in fields or while a sheet is open; Esc closes an open sheet first
- **Live mode**: ⚡ button polls quote + current chain each tick, chart every 4th tick, with countdown and overlap guards (duration ladder — see Recent tickers bullet)
- **Extended hours**: extSession(q) is null unless NOW (New York) is inside a PRE or AH window, and only counts prints and quotes from that same window today; it picks the fresher of two signals inside the PRE (4:00–9:30 ET, vs prevclose) / AH (≥16:00, vs close) windows — the last trade print, or the extended NBBO mid (bid/ask with their own timestamps; Tradier often freezes `last` at the 15:59 closing print).
  Spreads >5% of mid rejected as overnight junk; null during RTH or when nothing is from today (ET).
  Shown as a dim secondary figure in the quote bar (qExt) and sticky bar
- **Sizing anchors on effectivePrice(q)** — the extended price when live, else last: entryVal blank default, renderShares/renderChain/shareShares, ADR usage, chart-click both-view split, sim spot, quick lookup + card refresh underlying.
  The entry input's placeholder cues it ("AH 181.00").
  The headline qPrice and sticky-bar price stay the official last with the ext figure alongside
- **Ext chip** (in the intraday interval row, extHours, persisted as chart_ext, device-local like show_daily): off by default, which keeps everything on regular hours.
  On, the chart's timesales fetch asks for 4:00 to 20:00 with session_filter=all, and pre-market and after-hours bars draw on a faint band.
  The default LOD / HOD then come from dayRange(): the latest session's 5m bars, extended hours included (extDay, extendedRange).
  Once that session's regular hours have begun the quote's low and high join in, since they update every live tick; before 9:30 they are still the prior session's, so pre-market bars stand alone.
  Everything that reads the day's range follows it: the default stops and their buffers, the quote bar and sticky bar LOD / HOD, ADR used, and the refresh of a pinned card on the loaded symbol.
  The shares card names the source 'Low of day, ext hours (LOD)' while extended bars are in.
  Turning it off puts sizing back on the quote's range at once, then refetches regular hours.
  The chart's VWAP and dashed HOD / LOD follow the bars shown, so with Ext on they start at 4:00.
  ATR, the opening range, quick lookup on other tickers, and the position chart stay on regular hours.
