# Trade alerts plan

Status: planning, nothing built.
Draft as of 2026-11-02; the decisions at the end are open.

## Goal

You trade in the app (Trade at Schwab, the Positions trades) and the people on your list get a text when you open a trade you chose to share.
After that, every change to that trade goes out too: adds, trims, stop moves, the exit.
The first alert for a trade always comes from you, by one of two routes:

- **In the app:** a Send button on the position, which shows the exact text first.
- **By text:** when an entry fills, the app texts you ('Filled: long AAPL 100 sh @ 187.20, stop 185.90. Reply A7 to alert 212 subscribers.'), and your reply sends it.

Texts go through Twilio.
Subscribers never use the app: no accounts and no sign-in, just texts.

## Principles

- **Fills are facts.** An alert says what Schwab filled, never what an order meant to do. A placed order that never fills sends nothing.
- **You start every trade's alerts.** Nothing goes to subscribers for a trade until you send its first alert. After that, its updates go out automatically until it's flat or you stop following it.
- **Never twice.** Each alert is a row before anything is sent, and each delivery is a row that is unique per subscriber, so a retry finishes the job without texting anyone twice.
- **Size stays private.** Messages give prices, stops, fractions of the position ('sold half') and results in R. They never give share counts or dollars. (Decision 2.)
- **One segment.** A text is at most 160 GSM-7 characters. No emoji and no em dashes: either one switches the whole text to UCS-2, which allows only 70 characters per segment and costs two or three times as much.
- **Fail loud to you, quiet to them.** When the watcher can't see Schwab (the login ended, a read failed), you get a text and subscribers get nothing. They never get a guess.
- **The numbers are plain code with tests.** The messages are built from Schwab's orders by a pure module with fixtures, like core/positions.js.

## What exists to build on

- **Trade at Schwab** places a DAY entry with a TRIGGER child stop, gets the order id from the 201, and saves the plan (setups, tactics, the stop and risk) in `order_plans` (docs/schwab.md).
- **Positions trades** do the stop, the breakeven stop, closes and trims, targets, the spread close and Edit. Each is a run of cancels, replaces and new orders (docs/positions.md).
- **Raw capture** keeps every Schwab order in `schwab_records` with a fingerprint, and planDelta finds new and changed orders. That's the same diff the watcher needs.
- **The Journal's fill reader** (fillsFrom, buildTrades, originalSize, the first-stop rule in withRisk) already defines what a trade is, its original size, and 1R.
- **The shared Schwab login** is in Vault (`schwab_login:<uid>`), with a compare-and-swap writer (set_schwab_login with p_expect) that keeps devices from overwriting each other's renewals.
- **The Edge Function pattern** (`supabase/functions/claude-model-example`): a self-contained handler.js that Node tests import, and a Deno index.ts around it.

**What's missing:** nothing sees a fill while the app is closed.
Today every Schwab read happens in a browser, and Positions only reads while its tab is open and visible.
Stop entries trigger and stops get hit when nobody's looking, so following a trade needs a watcher on a server.
That's the central piece of this project, and it changes one of the app's principles (next section).

## The big decision: a server reads Schwab

The journal plan said the Schwab login stays on the device.
Since then, the login has also been kept in Vault so devices can share it, but only devices use it.
The watcher would be the first time the server itself uses the login.

**A. Browser only.** Alerts go out from whichever device has the app open.
Nothing new to trust, but a stop hit while the app is closed goes out late or not at all, and a late 'stopped out' is worse than none.
Not workable for follow-ups.

**B. A Supabase watcher (recommended).** pg_cron calls an Edge Function, `alerts-watch`, every 15 seconds.
It reads Schwab only when there's something to watch: a followed trade, or fill texts turned on during market hours.
Each run takes the login from Vault, reads the account's orders with a GET, works out what changed since the last run, records the events, and sends the texts.
When the access token expires, the watcher renews it through the same compare-and-swap the devices use, so the watcher and your devices never fight over it.
Renewing needs the Schwab app key and secret, which only the Cloudflare worker has today, so they'd go into Supabase's function secrets too. (Calling the worker's /refresh from the server also works, but only because the worker checks nothing beyond the Origin header.)
Supabase already holds everything else the watcher needs (the login, order_plans, the journal) and can receive Twilio's webhooks.

**C. Schwab's streamer (later).** The ACCT_ACTIVITY WebSocket reports fills within about a second.
It needs a connection that stays open, which an Edge Function can't hold; a Cloudflare Durable Object could.
It's phase 3 if 15-second polling turns out to be too slow.

**Rate limits:** Schwab is reported to allow about 120 Trader API requests a minute per app (check this in the portal).
The watcher at 4 a minute, plus Positions at 2 a minute on an open device, stays well under that.

**Latency:** up to one poll (15s) plus Twilio's queue (next section).

**Security:**
Schwab tokens can't be limited to reading, so a bug in the watcher, or someone who breaks into it, could place orders.
- The watcher's code makes only GET calls to Schwab, and a test fails if any Schwab call in it uses another method.
- Settings says that while alerts are on, the server reads your Schwab orders with your login.
- A login lasts 7 days. The watcher texts you 24 hours before it ends and again when it ends. Until you log in again, alerts pause and followed trades show as paused.
- The watcher needs to know which account to read, and today the chosen account is kept only on the device. The account's hash and last 4 move into the alert settings.

## Detecting changes

The watcher compares what the position is, not each order Schwab lists.
A breakeven stop with a paired limit is a cancel, a cancel, a new stop and an OCO, and alerting each of those steps would text 'no stop' halfway through.

**Position state** (pure, core/alerts.js): from the account's orders and positions for the trade's symbol and side, the shares held, the average cost, the original size (originalSize's rule), the working stops (price and shares) and the working targets.

**Fills go out right away.** A fill that increases the position is an entry or an add, and one that decreases it is a trim, an exit or a stop-out.
A stop or market order that fills is labelled by its order type, so 'stopped out' only ever comes from a stop order.

**Stop and target changes wait to settle.** They go out once two reads in a row show the same state, so a Positions run sends one 'stop to 187.20', not its intermediate steps.
A stop that's replaced (Schwab marks the old one REPLACED and creates a new one) counts as one move.

**Partial fills:** an entry that fills in pieces is one entry alert, at the price of what's filled so far.
Since size isn't shown, later pieces of the same order send nothing.

**Flat ends it.** When Schwab shows no position, the trade's last alert is the exit, and the trade is no longer followed.

**Trades placed outside the app** (thinkorswim, Schwab's mobile app) show up the same way, since the watcher reads Schwab's orders rather than the app's.

## Messages

Each message starts with a short service name (carriers expect the sender to be identified) and fits in one segment.
KSA below stands in for that name (decision 10).
The trade's 1R is the Journal's: entry to the first stop.

| Event | Example |
|---|---|
| Entry | `KSA: Long AAPL @ 187.20. Stop 185.90.` |
| Entry with your note | `KSA: Long AAPL @ 187.20. Stop 185.90. Starter, adding over 190.` |
| Add | `KSA: Added AAPL @ 189.10. Stop 186.50.` |
| Trim | `KSA: Sold 1/2 AAPL @ 191.40 (+3.2R). Stop 187.20 on the rest.` |
| Stop moved | `KSA: AAPL stop to 187.20 (breakeven).` |
| Target set (off by default) | `KSA: AAPL target 194.00 on 1/4.` |
| Exit | `KSA: Out of AAPL @ 192.00. +3.7R on the trade.` |
| Stopped out | `KSA: Stopped out of AAPL @ 185.88. -1.0R.` |
| Correction | `KSA: Correction: ignore the last AAPL alert. Still long, stop 187.20.` |

**Fractions:** trims are shown as a fraction of the original size: 1/4, 1/3, 1/2, 2/3 or 3/4 when the trim is within a few percent of one, otherwise a percent ('sold 30%').

**Options** use the Positions label ('AAPL 12/18 250C'). Spreads come later.

**Your note** can be added only to an alert you send by hand. The review shows a live character count, and a note that makes the text longer than one segment says so ('2 texts each').

**The composer:** core/alerts.js (pure) builds the text, and both the app's preview and the Edge Function use it, so the preview is exactly what gets sent.
Phase 1 checks whether the Supabase deploy can bundle a file from `src/core/`. If it can't, a copy goes in `supabase/functions/_shared/` with a test that keeps the two files identical, like the CSP test does for `_headers`.

## Starting a trade's alerts

**Send from Positions:** stock and ETF rows, and the phone actions sheet, get an **Alert** button.
It opens a review sheet (SHEETS.alert) with the exact text, an optional note, the subscriber count and the cost ('212 texts, about $2.80').
Send starts following the trade and sends the entry alert.
A followed row shows a **Following** tag, which opens the trade's alert history (what went out, how many were delivered) and **Stop following**.

**Reply to the fill text:** with **Text me fills** on, every fill that opens a position texts you, whether it was placed from the app or anywhere else.
Each of these texts has its own short code (A7), and a reply with that code sends that trade's entry alert, so replying to an old text can't alert the wrong trade.
A code expires after 15 minutes, since the price has moved on by then, and the reply to a late code says it expired.
The text to you includes the share count; the text to subscribers doesn't.

**Arm at Place (later, decision 5):** an **Alert subscribers: Off / When filled** row in the Trade at Schwab sheet, for breakout stop entries that fill while you're away.
An armed entry that's cancelled or expires without filling sends nothing.

**Pause everything:** **Pause alerts** in Settings, or text PAUSE to the alerts number from your own phone, stops all sends until you resume.
It's the fast way out when something looks wrong.

## Subscribers

**Joining:** a person texts JOIN to the alerts number, and gets back the service name, roughly how often alerts come, 'Msg & data rates may apply', 'Reply STOP to cancel, HELP for help', and that alerts go out after your own orders fill and aren't advice. They reply YES to confirm.
They're active only after YES (double opt-in).
Their consent is kept: the number, the time, the IDs of the inbound messages, and the exact confirmation text they were sent.

**Added by you:** you can type a number in the app, but it only gets the confirmation text and stays pending until it replies YES. Nobody joins without saying yes.

**STOP, START and HELP:** Twilio's Advanced Opt-Out on the Messaging Service answers these and blocks sends to numbers that have opted out.
The inbound webhook also sees STOP and marks the subscriber stopped, so the count stays right.

**The list in the app:** Settings → Alerts shows the count, each subscriber (a name you give them and the number, masked) with their status and join date, and Remove.

**A web sign-up page** (later): its own page with a phone box and the same disclosures. Not in v1.

## Twilio

- **Setup:** one account, one Messaging Service, and one number for both alerts and JOIN.
- **Secrets:** TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID go in Supabase's function secrets. The app never talks to Twilio.
- **Webhooks:** inbound messages and delivery status callbacks go to an Edge Function (`alerts-inbound`), deployed with `--no-verify-jwt` like claude-model-example. It checks the X-Twilio-Signature header itself and refuses anything unsigned.
- **Number type:** this sets throughput and needs registration, which takes days to weeks and has to be done before any of this can run.
  A local number needs A2P 10DLC (a brand plus a campaign, with sample messages carriers review).
  A sole proprietor brand (no EIN) is limited to 1 campaign, 1 number, about 1 message a second and about 1,000 a day to T-Mobile.
  A toll-free number needs toll-free verification instead, and starts with more throughput.
  A Standard brand (with an EIN) gets throughput based on its trust score.
  Check the current limits when you sign up; they change.
- **Fan-out time:** subscribers ÷ messages per second. At 1 a second, 200 subscribers wait up to 3 minutes 20 seconds for an alert; at 10 a second, 20 seconds. This is why the number type matters for trade alerts.
- **Fair order:** the send order is shuffled for each alert, so the same people aren't always last.
- **Cost:** about $0.0083 a segment plus a carrier fee of roughly $0.003 to $0.005, so about 1.2 to 1.4 cents a text.
  For example, 200 subscribers × 3 trades a day × 4 texts a trade × 21 days is 50,400 texts, roughly $600 to $700 a month.
  Number rental is a dollar or two a month. Check twilio.com/sms/pricing.
- **Budget cap:** a monthly limit in Settings. Past it, nothing goes to subscribers and you get one text saying why.
- **Delivery:** status callbacks fill in each delivery's status (queued, sent, delivered, failed, undelivered) and Twilio's error code, so a trade's history shows '212 sent, 209 delivered'.

## Data

These are new tables in a migration after the baseline.
Each has row-level security and an owner rule (tests/rls.test.mjs), and the Edge Functions use the service role.

| Table | What | Notes |
|---|---|---|
| `alert_settings` | One row per user: on, paused, your phone (E.164, confirmed by a code), fill texts on/off, the account hash and last 4, the service name, how results show (R, % or nothing), the monthly budget | Synced like settings |
| `alert_subscribers` | Phone (E.164), name, status (pending, active, stopped, removed), consent (jsonb: keyword, inbound IDs, time, the confirmation text), joined_at, stopped_at | Unique (user, phone) |
| `alert_trades` | The followed trade: account last 4, symbol, side, status (armed, following, closed, stopped, paused), how it started (send, reply, place), order ids, the last settled state (jsonb), trade_key, opened_at, closed_at | One open row per account, symbol and side |
| `alert_events` | One alert: its trade, kind (entry, add, trim, stop, target, exit, stopped_out, correction), the exact text, status (waiting for you, sending, sent, skipped), recipient count | Unique dedupe key: trade, kind, order id, filled quantity or state hash |
| `alert_deliveries` | One text: the event, the subscriber, Twilio's message SID, status, error code | Unique (event, subscriber): nobody gets it twice |
| `alert_prompts` | The fill texts sent to you: code, trade, fill details, expires_at, used_at | |

The watcher keeps what it last saw (order ids and fingerprints) in `alert_trades.state`.
Later, raw capture could reuse those reads instead of making its own.

## App changes

- **Settings → Alerts:** the alerts number to give out, your phone and confirming it, Text me fills, Pause alerts, the subscriber list, the monthly spend so far, the budget, and the disclosure that the server reads your Schwab orders.
- **Positions:** Alert and Following on rows and in the actions sheet, the alert review sheet, and a trade's alert history.
- **Trade at Schwab:** the Arm row (later).
- **core/alerts.js** (pure, `// @ts-check`): positionState, alertEvents(prev, next), alertText(event, prefs), and a GSM-7 and segment check. Tested with Schwab order fixtures, including Positions' multi-step runs.
- **docs/alerts.md:** the area doc once phase 1 lands, with a pointer in CLAUDE.md.

## Phases

**0. Accounts and registration** (you, no code): a Twilio account and number, toll-free verification or a 10DLC brand and campaign with sample messages, a service name, Supabase Pro (the free plan pauses projects and has no backups), and answers to the decisions below.
This has the longest lead time, so start it first.

**1. Shadow mode: texts to you only.** The watcher, the composer, fill texts, and every follow-up alert sent to your phone as 'Would send: …'.
There are no subscribers yet.
This proves fill detection, the settle rule, login renewal and latency on your real trades, with nobody else watching.
Run it for a week or two and compare the texts with the Journal.

**2. Subscribers.** JOIN, YES and STOP, the list in Settings, Send from Positions, reply to send, automatic follow-ups, Pause, the budget, delivery status.
Stocks and ETFs only.

**3. Later:** single-leg options, then spreads; Arm at Place; Schwab's streamer, if 15 seconds is too slow; the web sign-up page; payments, if you ever charge.

## Risks

- **Securities law** (not legal advice): a free list about your own trades, the same for everyone, is the simple case. Charging, or tailoring alerts to people, raises investment adviser questions.
  Never sell into buying your own alert caused, and say in the join text that alerts go out after your own fills.
  Talk to a securities lawyer before charging or growing past people you know.
- **Texting law:** consent and opt-out are covered above. Some states limit what hours texts can be sent, and extended-hours fills can land early in the morning (decision 8).
- **Carriers** can filter stock-alert texts. The texts you actually send should match the sample messages you registered, and should have no links at first.
- **A wrong alert** (a false 'stopped out' to everyone) is the worst failure. Shadow mode, the settle rule, Pause by text and the Correction message are there for it.
- **Gaps** when the Schwab login lapses or Supabase is down. You get texted; subscribers just don't hear anything.

## Decisions for you

1. **Free or paid?** This plan assumes free. Paid adds Stripe and the legal questions above.
2. **What subscribers see:** price and stop for sure. Share count? R, %, or no results? Setup name?
3. **Follow-ups:** automatic once you start a trade (what you described, and this plan's default), or does each one need a tap or reply from you?
4. **Which changes count:** fills and stop moves for sure. Targets you set (working limit orders that haven't filled)?
5. **Ways to start:** Send in the app, reply to the fill text, Arm at Place: which ones, and which first?
6. **Speed:** is up to about 15 seconds after the fill, plus fan-out, fast enough?
7. **Number:** do you have an EIN or a business? That decides between toll-free and a Standard 10DLC brand; a sole proprietor brand is too slow past a few dozen people.
8. **Extended hours:** alert fills outside 9:30 to 16:00?
9. **Size of the list:** tens, hundreds, thousands? This drives the number type and the cost.
10. **The service name** that starts every text.
