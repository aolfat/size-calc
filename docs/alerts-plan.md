# Trade alerts plan

Status: planning, nothing built.
Draft as of 2026-11-02, revised the same day around the alert service that already exists (aolfat/Olfat-Stonkz).
The decisions at the end are open.

## Goal

You trade in this app (Trade at Schwab, the Positions trades), and your subscribers get a text when you open a trade you chose to share.
After that, every change to that trade goes out too: adds, trims, stop moves, the exit.
The first alert for a trade always comes from you, with one tap.

## What already exists (Olfat-Stonkz)

This is read from the repo's `v0/` folder. The live Twilio Functions may be newer than the repo (decision 1).

- **Sign-up:** the Notion site links to Stripe Checkout, which collects a phone number. The `stripe-webhook` Edge Function, in Olfat-Stonkz's own Supabase project, adds a row to `subscriptions` (phone_number, active).
- **Sending:** a Twilio Function (`send-alerts`) runs on every text to the alerts number. It sends the same text, pictures included, to every active subscriber, and logs it in `messages`.
- **You send an alert by texting the number.** Nothing else starts a send today.
- **The texting standard** (`specs/custom-alert-texting-standard.md`) is the format you text in: `buy $NVDA 950 full`, `trim $NVDA 975 1/2`, `stopped $NVDA 950`. It has size words (lotto, quarter, third, half, full) and price, but no share counts.
- **A planned rewrite** in the same repo has Tradier sync, a trade engine, a parser for your texts, `alerts` and `alert_deliveries` tables, and auto-send on fills. It was last pushed in April 2026, and how much of it is live is decision 2.

## How the work splits

This app knows the trade: Schwab's orders, the plan, the stop, the original size, R.
Olfat-Stonkz knows the people: who's paid and how to reach them.
So this app writes the alert, and the existing number sends it.
No subscriber data, Stripe, or Twilio sending logic comes into this app.

| Where | What it does |
|---|---|
| This app | Notices fills and changes, writes the alert text, the Send button, which trades are being followed |
| Twilio Functions | Who gets a text and the sending; your commands to the number; later, drafts that wait for your reply |
| Olfat-Stonkz Supabase | Subscribers, the `messages` log, later the drafts |
| This app's Supabase (phase 3) | The Schwab login, and the watcher that follows trades while the app is closed |

## Messages: the texting standard

Alerts from this app use the texting standard, so subscribers keep getting what they already get, and the rewrite's parser can read them into trades like the texts you type.

| Event | Text |
|---|---|
| Entry | `buy $AAPL 187.20 half` |
| Entry with the stop | `buy $AAPL 187.20 half, stop 185.90` (the stop isn't in the standard: decision 3) |
| Short entry | not in the standard: decision 3 |
| Add | `adding $AAPL 189.10 quarter` |
| Trim | `trim $AAPL 191.40 1/2` |
| Stop moved | `update: $AAPL stop to 187.20` |
| Exit | `sold $AAPL 192.00` |
| Stopped out | `stopped $AAPL 185.88`, or `stopped $AAPL breakeven` when it's within a cent of your average cost |
| Option entry | `buy $SPY 3/15 520c 1.20 lotto` |

**Size words:** the rewrite defines them by position value as a share of the account: full is 5%, three-quarters 3.75%, two-thirds 3.33%, half 2.5%, third 1.67%, quarter 1.25%, lotto 1%.
This app has both numbers (position value, and the account value from Schwab), so it picks the nearest word, and the send sheet lets you change it (decision 4).

**Trims** are a fraction of the original size: the most held since the position was last flat, using the Positions close ticket's rule (originalSize).
The fraction is snapped to 1/4, 1/3, 1/2, 2/3 or 3/4 when it's within a few percent of one; otherwise it's a percent (`trim $AAPL 191.40 30%`).

**Your note:** an optional line you add before sending.

**The composer:** core/alerts.js (pure, `// @ts-check`), tested against the examples in the texting standard.
Each text should parse back to the same action with the rewrite's text-parser (packages/shared/trades/text-parser.ts). That's checked once by hand, since the two repos don't share tests.

## Phase 1: one tap through Messages (this app only)

**Send** builds the alert and opens Messages addressed to the alerts number, with the text already typed (an `sms:` link). You tap send.
It reaches the existing number from your phone, exactly as if you'd typed it, so nothing in Twilio, Stripe or Olfat-Stonkz changes.
This works on iPhone and in Mac Messages. Anywhere else, the sheet has **Copy** instead.

**Where Send shows up:**
- The Trade at Schwab result, once the status check shows the entry filled.
- Positions: an **Alert** button on stock, ETF and option rows, and in the phone actions sheet. It picks the event from what changed: entry on an un-alerted position; add, trim, exit or stop moved on a followed one.
- **Prompts while the app is open:** when Positions' 30s read sees a fill or a settled stop move on a followed trade, the row shows **Send alert** with the text ready. It doesn't send anything by itself.

**Followed trades:** sending an entry marks the position as followed (account last 4, symbol, side, the state it was sent at), in a small table in this app's Supabase, so every device knows.
The position stops being followed when it goes flat.

**Settle rule:** a stop or target change counts once two reads in a row agree, so a breakeven-stop run (cancel, cancel, new stop, OCO) prompts one 'stop to 187.20', not each step.
Fills count right away.

**Settings → Alerts:** the alerts number (synced), and whether the size word is picked for you or by you.

**What it doesn't do:** follow-ups need your tap, and only show while the app is open.
A stop hit while the app is closed shows up as a prompt the next time Positions reads.

## Phase 2: hardening on the Twilio side (Olfat-Stonkz)

These are things in the repo copy worth fixing before anything sends without your thumb on it. Skip any the live Functions already handle.

- **Anyone can broadcast.** `send-alerts` doesn't check who texted, so any text to the number goes to every subscriber: a subscriber's reply, a wrong number, even STOP. Fix: only broadcast when From is your number; Twilio's Advanced Opt-Out handles STOP, START and HELP.
- **Cancelled subscribers keep getting texts.** `stripe-webhook` only handles checkout.session.completed, so nothing turns `active` off when a subscription ends. Fix: handle customer.subscription.deleted and payment failures (the rewrite's milestone 1.5).
- **All or nothing.** The send is one Promise.all inside Twilio Functions' 10-second limit. If one number fails, the call fails after the others went out, and nothing records who got it, so a retry texts everyone again. Fix: a row per recipient (the rewrite's `alert_deliveries`).
- **Signatures:** check that the function's visibility is Protected, so only Twilio can call it.
- **A way in for a server:** a `broadcast` Function that takes a secret header and an idempotency key, runs the same fan-out, and logs to `messages` with sender `size-calc`. A key it has already seen does nothing.

## Phase 3: automatic follow-ups (the watcher)

Nothing in this app sees a fill while every device is closed.
A stop hit or a breakout entry fills when nobody's looking, so automatic follow-ups need a watcher on a server.

**The watcher:** pg_cron in this app's Supabase calls an Edge Function, `alerts-watch`, every 15 seconds, but it reads Schwab only while a trade is followed (or fill texts are on) during market hours.
Each run takes the shared Schwab login from Vault, reads the account's orders with a GET, applies the settle rule against the followed trade's last state, and posts each new alert to the `broadcast` Function.
When the access token expires, the watcher renews it through set_schwab_login's compare-and-swap, the same one devices use.
Renewing needs the Schwab app key and secret in Supabase's function secrets (today only the Cloudflare worker has them).

**Fill texts with a reply to send:** for trades that aren't followed yet, the watcher posts a draft to a `draft` Function.
It saves the draft in Olfat-Stonkz's Supabase and texts only you, from the alerts number: 'Filled: long AAPL 100 sh @ 187.20, stop 185.90. Reply A7 to send: buy $AAPL 187.20 half'.
`send-alerts` gets one more branch: when you text a live code, it broadcasts that draft instead of the text 'A7', and tells the watcher the trade is now followed.
Codes expire after 15 minutes.

**Shadow mode first:** for a week or two, every follow-up goes only to you as 'Would send: …'. Compare those texts with the Journal before turning it on for subscribers.

**Security:**
- This is the first time the server itself uses your Schwab login, not just stores it, and Schwab tokens can't be limited to reading.
- The watcher's code makes only GET calls to Schwab, and a test fails if any Schwab call in it uses another method.
- Settings says that while follow-ups are on, the server reads your Schwab orders.

**Schwab, not Tradier:** the Olfat-Stonkz plan picked Tradier and ruled Schwab out for automation because its login lasts only 7 days.
This app's shared login makes Schwab workable, but it still needs you once a week.
When the login lapses, the watcher pauses and texts you 24 hours before it ends and again when it does. Subscribers just don't hear anything until you log in.
Phase 1 doesn't depend on any of this.

## Risks

- **A wrong alert** (a false 'stopped out' to everyone) is the worst failure. Phase 1 always has your tap; phase 3 has the settle rule, shadow mode, and a correction text (`update: ignore the last $AAPL alert, still long, stop 187.20`).
- **More texts cost more:** automatic follow-ups mean more texts per trade, and the cost scales with subscribers × texts. Phase 1 adds no texts you wouldn't have sent anyway.
- **Paid alerts:** charging for alerts about your own trades raises securities-law questions. Never sell into buying your own alert caused, and say alerts go out after your fills. That's a question for a securities lawyer, not this plan.

## Decisions for you

1. **The live Twilio Functions:** are they the repo's `v0/twilio/functions/send-alerts.js`, or newer? Paste them here, or commit them to Olfat-Stonkz. Phase 2 depends on this.
2. **The Olfat-Stonkz rewrite** (Tradier sync, parser, the new tables): live, paused, or replaced by this?
3. **Format:** the texting standard as above, or the multi-line NEW POSITION template from the rewrite's spec? Include the stop on entries? How do shorts read?
4. **Size word:** picked from position value as a share of the account (full = 5%), or always picked by you?
5. **Stop moves:** send them as `update:` texts, or only fills?
6. **Phase 3 at all:** are phase 1's prompts (one tap each, app open) enough, or do follow-ups need to go out with nobody watching?
