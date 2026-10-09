# Trade journal plan

Status: phase 1, step 1 (Google sign-in and settings sync through Supabase) is built. The rest is planning. Decisions as of 2026-10-08.

**Update (2026-10-09):** `main` already retired saved position cards. Positions shows live Schwab positions, with breakeven stops and closes. So "saved positions retire" below is done, and the journal's open trades can build on the live Schwab positions.

## Goal

Turn the calculator into a trade journal that imports trades on its own and makes reviewing every trade fast enough that it actually happens. Tradezella-style screens, plus two things the open-source journals don't do:

- **It knows your plan.** The calculator already has the risk $, stop, and entry at the moment you size a trade, so R is exact instead of typed in after the fact.
- **A review deck.** Swipeable cards of new trades with labels pre-filled by the app. You confirm or fix them, grade the plan, and add a note.

## Principles

- **Fills are facts.** They're only ever added. Trades, P&L, R, flags, and stats are computed from fills, plans, and your input, never stored as truth. Fixing the grouping logic fixes every past trade.
- **The server is the source of truth.** Devices keep a cache for speed and offline review.
- **The numbers are plain code with tests.** No AI in the first version.
- **The front end keeps no build step.** Its one dependency is Supabase's JavaScript library: a bundled copy downloaded once, pinned, committed to the repo, and updated by hand. No CDN at runtime. CLAUDE.md's no-dependencies rule gets this exception when it lands.

## Decisions

### Users and sign-in

- **Others will use it eventually.** Build for one user first, but multi-user from the data model up.
- **Supabase Auth handles sign-in.**
  - **Google first.** Supabase's Google provider handles the OAuth flow.
  - **Sessions:** Supabase issues the session as a bearer token and refreshes it, so there are no cookies between sites to deal with.
  - **Passkeys next,** as a quick unlock added to an account after the first Google sign-in. Supabase's passkeys are in beta (since May 2026) and experimental in its JavaScript library, so check their status before building on them.
  - **Several sign-in methods per user** are built in: Supabase links identities to one user.
- **Apple sign-in is skipped** for now. It needs the $99 a year Apple Developer Program.
- **The server can read trades.** It's a normal backend, like Tradezella, and the database has to be protected accordingly.
- **The Schwab login stays on the device.** It can place real orders, so the server never stores it. The app imports fills and sends them to the server.
- **Other people get trades in by CSV first.** This app's Schwab developer app is on the Individual tier, which only covers its owner's accounts. Live connections for others come later, through Schwab's Commercial tier or a commercial aggregator like SnapTrade.

### Storage

- **Backend:** Supabase, a hosted Postgres database plus Supabase Auth.
- **Keeping users apart:** row-level security on every table, so each row is visible only to the user who owns it (`user_id = auth.uid()`). Supabase's public app key is meant to be public, which makes this the only thing between one user and another's trades.
  - A test checks that every table has row-level security turned on and an owner rule.
  - A table without its rule is the classic Supabase leak.
- **Where the work happens:** imports and grouping run in the browser, because the Schwab login lives on the device. The browser then writes fills, plans and reviews to Supabase.
- **Cloudflare stays for the Schwab worker.** Settings sync retires once settings move into Supabase.
- **Settings move into Supabase, the Tradier key included.**
  - **The Tradier key is encrypted with Supabase Vault,** readable only through one function the app calls. A Tradier key on a brokerage account can place orders, and Vault protects it if a backup or export leaks. You as the operator could still decrypt it.
- **Device:** an IndexedDB cache. Settings stay in localStorage.
- **Conflicts:** the database applies edits in order and the newest edit wins, notes included.
- **Free plan:**
  - pauses after a week of low activity
  - no automatic backups
- **Pro ($25 a month):** no pausing, 8 GB, and 7 days of daily backups. Moving to Pro is an open question.
- **Backups:** a weekly export reminder. The export is JSON you can re-import, plus a trades CSV. On the free plan it's the only backup.

| Kind | What | Notes |
|---|---|---|
| **Facts** | **Fill:** broker id, account, symbol (an option uses its full contract symbol), shares or option, buy or sell, quantity, price, fee, time, order id | Deduped by broker id. About 150 bytes each |
| | **Stop order:** order id, symbol, stop price, placed time, status, what replaced it | Feeds the "moved stop" flag and finding the first stop for R |
| | **Plan:** symbol, direction, entry, stop, risk $, account size, quantity, setup if tagged, order id if placed from the app | Written when you size or place a trade |
| | **5-minute bars:** one set per symbol per day held | Saved at import, one row per symbol per day with the day's bars packed in. Tradier keeps them only about 40 days |
| **Your input** | **Review**, keyed by account, symbol, direction, and open time: plan grade, rule checks, flags kept or dismissed, note, the stop if the card asked for one | Swings get an entry review and a close review. Also saves the trade's fill ids, so it can re-attach if a late fill changes the open time |
| | **Day:** market label, daily note | |
| | **Labels:** sector, daily setups, entry tactic, tags, market override | Their own table, one row per label on a trade. Records who set it (you or the app) and how confident a guess was |
| | **Library:** levels, actions, patterns, entry tactics, tags, mistakes, emotions | Shared defaults, read-only and the same for everyone, plus each user's own items. A user can hide defaults they don't use. Labels store ids, not names, so renames and merges never rewrite old trades |
| | **Import progress** per account | So two devices don't both re-pull the same days |
| **Computed** | Trades, P&L, R, flags, label guesses, stats | Rebuilt from the above |
| **Device only** | Schwab login and account choice, chart preferences, cached daily bars | Never on the server |

Rough size: about 5 to 7 MB a year of active trading, most of it 5-minute bars, before Postgres's own overhead. The free plan's 500 MB holds years of it for one user. Pro's 8 GB is enough for many users.

### Tables (draft)

**Rules for every table**
- **`user_id` on every row.** Row-level security lets each user read and write only their own rows.
- **Shared default library items** have no owner. Every signed-in user can read them, and no user can change them; they're edited through the Supabase dashboard.
- **Deleting an account** deletes everything it owns.

| Table | One row per | Holds |
|---|---|---|
| `broker_accounts` | Broker account | Broker, last 4 digits |
| `fills` | Fill | Account, Schwab's fill id (unique per account, so re-imports can't duplicate), order id, symbol, shares or option, side, quantity, price, fee, time. Exact decimals for money |
| `stop_orders` | Stop order | Stop price, placed time, status, what replaced it. Status updates, so not strictly add-only |
| `plans` | Sizing | Symbol, direction, entry, stop, risk $, account size, quantity, order id, and a snapshot of the card it came from |
| `bars_5m` | Symbol per day | One day's 5-minute bars packed together. Per user, assumed, because sharing bars fetched with one person's Tradier key likely runs into data-redistribution rules |
| `days` | Trading day | Market label, daily note |
| `reviews` | Trade, per stage | Plan grade, rule checks, flags kept or dismissed, note, stop if asked, the trade's fill ids |
| `trade_labels` | Label on a trade | Dimension (sector, daily setup, entry tactic, tag, market override), the library item, who set it, guess confidence |
| `library_items` | Item | Kind (level, action, pattern, entry tactic, tag, mistake, emotion), name, settings like the pivot's minimum reds, what it merged into. No owner means a shared default |
| `library_hidden` | Hidden default | A shared default a user has hidden |
| `import_runs` | Import | Account, when, imported through, counts, errors |
| `settings` | User per key | Account size, risk %, presets, stop strategy, last ticker, Tradier environment. One row per key, so edits to different settings on two devices don't overwrite each other. The Tradier key is kept in Vault, not here |
| `saved_positions` | Position | Temporary. Today's saved cards, until open trades come from imported fills. A delete sets `deleted_at` |

**Trades aren't a table.** Reviews and labels point to a trade key (account, symbol, direction, open time), and the trade is rebuilt from fills.

### Hosting

- **The app stays on GitHub Pages.** It's still static files. The browser talks to Supabase directly, with Supabase's public key, and row-level security decides what each user can see.
- **No server of our own.** Anything the browser can't do, like a scheduled job or a secret key, goes in a Supabase Edge Function or a Cloudflare Worker.
- **Supabase is told the app's address,** so Google sign-in can send you back to it.
- **The domain is decided before passkeys.** Passkeys are tied to the site's domain, so moving afterward would break them. GitHub Pages supports custom domains if we want one.

### Imports

- **Schwab first.** Robinhood comes later, by CSV.
- **The Import button** catches up since the last import. On day one it pulls the last 60 days, the limit of Schwab's order history.
- **Opening the Journal while logged into Schwab** pulls today's fills automatically, one quick call. This replaces the live tracking saved positions gave.
- **Sources:** Schwab's orders give fills (execution legs) and stop orders. Schwab's transactions (type TRADE) give fees. How far back transactions reach is unclear, 60 days or up to a year depending on the source. Settle it with one live call.
- **Grouping:** fills become trades flat to flat, matched first in, first out, including partial fills, scale-ins, flips, and the ×100 option multiplier. Port LuxAlgo's `round-trips.ts` (MIT, keep the notice).
- **Bars:** each import saves 5-minute bars for every day each trade was held, open swings included. Importing less often than about monthly risks losing bars (Tradier keeps about 40 days) and orders (Schwab keeps 60 days).
- **The Schwab login lasts 7 days.** The Import button needs a login within the last week.

### Plans and R

- **A plan is recorded whenever you size a trade:**
  - a Trade at Schwab ticket, saved when Schwab confirms the order (today the ticket disappears when the sheet closes)
  - a pinned card or quick lookup card
- **Saved positions retire.** The card's "save" becomes "plan", and open trades come from imported fills.
- **R comes from, in order:**
  1. the plan made in the app
  2. the first stop order on the position
  3. the review card asking for the stop you had in mind
- **Matching fills to plans:** by order id when the app placed the order. Otherwise by symbol (the full contract symbol for options) within a time window, which is still to be set.

### Labels

Every trade is labeled along separate dimensions:

| Label | Choices | Per trade | How the app guesses |
|---|---|---|---|
| **Market** | Bullish, neutral, bearish, choppy | 1, set once per day | SPY and QQQ, rule to be set |
| **Sector** | Strong, weak, neutral, n/a | 1 | The stock's group ETF, rule to be set |
| **Daily setups** | A level plus an action, or a standalone pattern | Several, all equal | Daily bars at entry |
| **Entry tactic** | 6/20 (Gil Morales), 15-minute pivot, 30-minute pivot, more | 1 | 5-minute bars and entry time |
| **Tags** | Option flow, more | Any | You add them |

**Market**
- Set once per trading day. Every trade that day inherits it, and you can override it on a single trade.

**Sector**
- The benchmark is the stock's group ETF.
- This needs a hand-checked table from the Market data's 146 industry groups to its 88 group ETFs. Nothing links them today. Maintain it like the leveraged ETF list.
- A group with no matching ETF falls back to its S&P sector ETF.

**Daily setups**
- **Levels:** 50, 100, and 200 SMA. 8 and 21 EMA. Support and resistance. AVWAPs anchored to the all-time high, the all-time low, earnings, and more.
- **Actions:** bounce, undercut and rally, rejection.
- **Standalone patterns:** base breakout, pennant or flag breakout, earnings gap.
- Swing and day trades share one list, and you can add more.
- A trade counts toward each of its setups, so setup report rows won't add up to the overall total. Reports must say so.

**Entry tactics**
- **Pivot:** on the 15 or 30 minute chart, the first green candle after at least 2 red candles in a row.
  - Green means close above open, and red means close below open. A doji is neither, so it breaks the red streak.
  - The red streak can include the prior day's last candles, unless "red streak must be within the pivot's session" is on.
  - The minimum number of reds (default 2) is a setting.
- **Pivot entry:** entering at the pivot candle's close or on the break of its high both count.
  - Assumed, not yet confirmed: the entry must come at that close or during the next candle.
- **Shorts** mirror it: the first red candle after at least 2 green ones, entered at its close or on the break of its low.
- **A trade that fits both** the 15 and the 30 minute pivot is labeled a 30-minute pivot.
- 15 and 30 minute candles are built from 5-minute bars within each session, as the calculator's chart already does.

**Library**
- Quick add from a review card. Tidy up later in the library, with rename and merge.

### Review deck

- **The Journal is its own tab.**
- **A banner** above the risk strip says "N trades to review". It never blocks anything.
- **Phone and desktop are equally important:** swipes on the phone, arrow keys on desktop.
- **A card shows:**
  - symbol, direction, size, and times
  - the daily and 5-minute charts with your fills and stop
  - a row per label, filled in with a guess and the reason for it
  - mistake flags
  - the plan grade, and a note
- **Required on every card:** confirm the labels, grade the plan, check the flags, write a note. Dictation keeps the note fast.
- **P&L is hidden until you grade the plan.** A setting can show it up front.
- **Swings get two cards:** at entry (labels and plan) and at close (grade and note).
- **Proposed, not confirmed:** swipe right accepts, left fixes a label, up saves the trade for the weekly review.

### Charts

- Every trade shows the daily and the 5-minute chart, with your fills, entry, and stop drawn on them.
- For a swing, the 5-minute pane opens on the entry day and steps through each day held. This is an assumption, not confirmed.
- **5-minute bars are saved at import,** because Tradier only serves about 40 days of them. That keeps every trade's chart, and lets pivot detection and the for-and-against numbers be re-run if a rule changes. Daily bars aren't saved, since Tradier serves years of them.
### Mistake flags

Caught automatically, and you dismiss the false ones. The proposed list:

- **Oversized:** actual risk over the planned risk.
- **Moved stop:** the stop order was replaced or canceled.
- **Revenge trade:** entered within a few minutes of a loss.
- **Exited early:** closed before both the stop and the target.

The cutoffs are still to be set.

## Not in the first version

- AI features (weekly summaries, voice diary)
- Screenshots and other attachments
- Robinhood imports, and live broker connections for other users
- Sign in with Apple
- A Delete my account button, to build before inviting anyone else
- A flashcard study deck: old trades shown up to the entry, take it or pass, then the outcome

## Borrowed from open-source journals

**[LuxAlgo trade-journal](https://github.com/LuxAlgo/trade-journal) (MIT)**
- The fill and trade model, and the stable trade key that keeps notes attached across re-imports.
- The grouping engine, to port.
- Playbook rule checklists, with performance compared for followed vs broken rules.
- Withholding scores on fewer than 5 trades.
- Cross-analysis between labels.

**[Trading-Journal-AI](https://github.com/simonro/Trading-Journal-AI) (MIT)**
- Tracking whether you or the app set each label.
- Showing low-confidence guesses first.
- Starter mistake and emotion lists.
- A library with rename and merge.
- Marking report rows under 10 trades as thin.
- Exit efficiency on winners only.
- Ending the weekly review with one rule for next week.

## Phases

1. **Foundation**
   - **First, [step 1](journal-step-1-supabase.md):** Supabase and Google sign-in. Move today's settings, Tradier key, and saved positions into Supabase, and remove the Cloudflare sync.
   - **Then:** the journal tables, the device cache, and export.
   - Can ship earlier on its own: save the Trade at Schwab ticket as a plan when the order is placed. Until then, every order loses its plan.
2. **Schwab import:** fills, stop orders, fees, dedupe, grouping into trades, 5-minute bars, today's fills on open.
3. **Journal tab:** trade list, trade page (charts with fills, labels, notes), P&L calendar, dashboard stats.
4. **Review deck:** cards, the banner, required fields, labels picked by hand.
5. **Guesses and flags:**
   - market and sector rules
   - daily setup detection
   - pivot and 6/20 detection
   - mistake flags
   - library management
6. **Reports:** breakdowns and cross-tabs by every label, the weekly review.
7. **Passkeys,** through Supabase's beta.
8. **More data in:** Schwab CSV backfill for older history, Robinhood CSV, onboarding for other users.

## Open questions

**Definitions**
- The 6/20 entry's exact rule.
- How you judge the market (bullish, neutral, bearish, choppy) and a sector (strong, weak), so the daily guess matches how you already call it.

**Cutoffs**
- How close to a level counts as a bounce, and how far under is an undercut.
- The revenge trade window.
- The window for matching a fill to a plan.
- The pivot entry window (assumed above).

**Product**
- What the Positions tab shows once saved positions retire: open trades, or fold it into the Journal.
- Swipe directions (proposed above).
- What the weekly review shows without AI, and whether next week's rule appears above the risk strip.
- Which dashboard stats matter most.

**Technical**
- **The domain:** stay on aolfat.github.io or move to a custom domain. Decide before adding passkeys or inviting anyone.
- **When to move to Pro:** the free plan pauses after a quiet week and has no backups.
- **Live updates:** whether to use Supabase Realtime so a review done on one device shows on the other at once, or just check for changes like today's sync.
- **How far back Schwab's transactions endpoint reaches** (one live call).

## Constraints and sources

- **Schwab:** orders reach back 60 days, and a login lasts 7 days. The Individual tier covers only your own accounts. ([schwab-py docs](https://schwab-py.readthedocs.io/en/latest/client.html), [MultiCharts on commercial review](https://www.multicharts.com/pm/public/multicharts/issues/MC-2885))
- **Tradier:** 5-minute and 15-minute bars go back 40 days for the regular session, 18 days with extended hours. Daily history goes back years. ([Tradier time and sales](https://documentation.tradier.com/brokerage-api/markets/get-timesales))
- **Robinhood:** the stock and options API isn't public. The activity report CSV takes about 2 hours, up to 24, and leaves out futures and crypto. ([Robinhood reports](https://robinhood.com/support/articles/finding-your-reports-and-statements/))
- **Supabase:**
  - **Free plan:** 500 MB database, 1 GB file storage, two active projects. No automatic backups. Pauses after a week of low activity.
  - **Pro ($25 a month):** 8 GB, 7 days of daily backups. Point-in-time recovery is a paid add-on.
  - **Passkeys:** in beta since May 2026.
  - ([pricing](https://supabase.com/pricing), [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing), [passkeys beta](https://supabase.com/changelog/46458-passkeys-for-supabase-auth-beta))
- **Cloudflare free plan** (Schwab worker and settings sync): KV has 1 GB and 1,000 writes a day. ([KV limits](https://developers.cloudflare.com/kv/platform/limits/))
- **SnapTrade:** personal keys are free for your own accounts. Commercial use is billed per connected user. ([SnapTrade personal vs commercial](https://docs.snaptrade.com/docs/personal-vs-commercial))
