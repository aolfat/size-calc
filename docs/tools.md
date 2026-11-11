# Tools

The top-level tabs and the Tools view: the % gain card, the leveraged ETF finder and the lev ETF price target.

- **Tools**: the header tabs ARE the top-level nav — 'Market / Size / Positions / Journal / Tools', keyboard-accessible buttons with aria-current on the active one.
  The open tab rides in the address (#market, #positions, #journal, #tools; Size has none; history.replaceState, so no back-button entries), and boot opens it (startView), so a reload stays on the tab; an address with no tab (the home-screen app always opens the bare start_url) opens the tab last open on this device (`last_view`, device-local); a reload on the Journal says 'Loading your journal…' while the stored session comes back (state.sessionResuming), then reads the records (startSession calls loadJournal).
  An open trade page isn't in the address: a reload lands on the trades list.
  On phones (≤600px) the same buttons become a fixed BOTTOM tab bar (five slots) with icons (.tab-icon, hidden elsewhere), clear of the home indicator via env(safe-area-inset-bottom) (viewport-fit=cover), hidden while a field has focus so the keyboard owns the bottom; the header then shows the screen title (#viewTitle, set by setView) and the settings button.
  Tapping the tab you're on does what an iOS app does (owner request: feel native): on a Journal trade page it goes back to the list, anywhere else it scrolls back to the top (smooth unless the device asks for less motion).
  Only the tab buttons do this; other buttons that open a view (data-action setView without .brand-nav) just open it.
  Phones show the screen title large (30px, as iOS does) and, once it scrolls under the top, a small centered title in a frosted bar (#titleBar, updateTitleBar in ui/native-feel.js); tapping it goes back to the top, and on Size the sticky quote bar takes the top instead.
  **Pull to refresh** (phones, attachPullRefresh): at the very top of a view, pull down and let go past 110px to run that view's own refresh: Size the quote (as ↻), Positions Refresh, Market today's quotes, Journal a fresh read (signed in, not on a trade page); Tools has none.
  A badge (#pullRefresh) slides down with the pull, its arrow turning until a release would refresh, then spins until the refresh answers (at least half a second, at most 15).
  The page keeps its own bounce; a gesture a chart claims, an open sheet or the simulator leave it alone, and html's overscroll-behavior-y: contain keeps Chrome's own pull-to-reload out of it.
  **Haptics** (effects.haptic): a light tap on the risk − and +, the long / short switch (only when it changes side), a chart long-press release, and a pull that refreshes; Android vibrates, and iOS 18 or later ticks for a hidden checkbox switch flipped inside the tap (there is no web haptics API there).
  **Hover needs a mouse**: every :hover rule sits in @media (hover: hover), so a tap never leaves a button lit on a phone; the one exception is a calendar day's events popover, which the tap opens.
  Click Size = calculator, click Tools = tools view (setView 'utils', keys t or u toggle tools ⇄ size).
  Tools view hides ALL calculator surfaces including the ticket card.
  Currently holds the % gain card (bought at / current price → gain %, per-unit change, multiple; renderGain, no API) and the leveraged ETF finder — add future small tools here
- **Leveraged ETF finder** (tools view): type a stock/index → its leveraged ETF family ranked by liquidity.
  LEV_ETFS is a CURATED static map (underlying → [sym, daily leverage], longs first; ~175 underlyings / ~385 ETFs after a full issuer sweep (Direxion, GraniteShares, ProShares, Defiance, T-Rex/REX, Tradr, Leverage Shares, Corgi, Volatility Shares, Roundhill) + index/sector/commodity/crypto/VIX; expect to keep adding — issuers launch and liquidate constantly (ARMU, Direxion's Apr 2026 bears, and REX's SOL/XRP funds all died in 2026); verify tickers via web search before adding, don't guess), LEV_ALIASES folds SPX/ES/VOO→SPY etc., LEV_REVERSE resolves a typed leveraged symbol to its family (TQQQ → QQQ set, with a note).
  Both/Long/Short seg (levDir) is a display filter over the last result (levLast re-renders without refetch; cleared on empty/no-match so a toggle can't resurrect a stale table).
  With a key, one /markets/quotes call ranks by dollar volume/day (average_volume × last, today's volume fallback); spread % of mid amber >0.25%; top long and top short get best-long/best-short badges (.lev-badge).
  No key = static list, unranked.
  Rows are tap-to-load: levLoad puts the symbol in the ticker field, jumps to the calculator, fetches when a key exists.
  Leverage labels are static and can drift when issuers change factors — quotes are live, labels aren't; a delisted map entry just quotes empty and sinks to the bottom
- **Lev ETF price target** (tools view): type a mapped leveraged ETF + a target price on its underlying + days → expected ETF price.
  The one-day case is core/lev-etfs.js fundPriceAt, which the Positions tab's fund link uses too (docs/positions.md, Off the underlying).
  Requires a key and a LEV_REVERSE symbol (typed underlying hints its family instead, no manual fallbacks by request).
  One quotes call for both symbols; days ≤ 1 is the exact daily reset (etfNow × (1 + lev·move), floored at 0); days > 1 applies GBM vol drag `gross^lev × exp((lev − lev²)/2·σ²·days/252)` with σ = underlying HV20 from a 60d /markets/history fetch (hv20At, extracted from applyDailyHistory and shared; too little history = drag skipped and noted).
  Stat grid: ETF at target (good/danger), ETF move %, underlying move %, and a Decay cost stat (vs the no-drag number) when days > 1.
  Estimate only — theta-free, IV/fees/borrow ignored, real chop drags more
