# Journal notebook: a page per trading day

Status: slice 1 built. Part of [the journal plan](journal-plan.md), beside [step 3](journal-step-3.md)'s trade and week reviews.

## Goal

A notebook for each trading day: write a plan before the open, then a short review after the close. The trade review asks about one trade and the week review about the week. The notebook asks about the day: how you came in, what you planned, and whether you stuck to it.

## Principles

1. **Quick, or it won't happen.** Each day asks only for a few things. Everything else is optional and stays out of the way until you use it.
2. **Write once what doesn't change.** Goals and rules are standing lists. You set them up once and they show every morning.
3. **The plan sits above the review.** You review the day with what you planned in front of you, like the entry note above the exit note on a trade.
4. **The app adds up the numbers, you write the words.** The day's trades and P&L come from Schwab. Nothing asks you to type a number the app already has.

## Where it lives

- **The calendar is the index.** Every weekday cell opens that day's page: a day with trades, a quiet day, today before the open, tomorrow (to write Monday's plan on Sunday). It used to narrow the Trades list to the day; that's the page's "The day's trades" link now.
- **The day page** replaces the calendar inside the Calendar tab: ← Calendar goes back, ‹ › step one weekday. Tapping the Calendar tab goes back too.
- **Today's line** under the Journal's status opens today's page (Monday's on a weekend): "Today: write your plan" until it's written, then "Review the day" after 4pm New York, then "Day reviewed".
- **Calendar marks:** ✎ plan written, ✓ day reviewed, and an amber dot once a day with trades is over and isn't reviewed.
- **Missed trades on the calendar:** ⊘ and how many you logged that day (⊘2), on any weekday.

## The page

Four sections, always in this order.

### Premarket

| Part | What | Required |
|---|---|---|
| Economic events | The day's US releases with their New York times and impact (docs/journal.md, Economic events), 'No major releases.' on a quiet day | Nothing to fill in |
| Last focus | The focus you wrote in your last review (up to a week back), at the top | Shown only when there is one |
| Mental check-in | How you feel (Calm, Focused, Confident, Anxious, Frustrated, Impatient, FOMO; any number), sleep and energy (Rested, OK, Tired), hours slept, where you're trading (At my desk, On my phone) | Feeling, energy and where; hours are optional |
| Goals | Your standing goals | Nothing to fill in |
| Rules | Your standing rules | Nothing to fill in; they're checked after the close |
| Market | The day's market chips, the same `journal_days.market` the trade review sets, so every trade that day inherits it | Yes |
| Focus list | The tickers you're watching, each with its setups (below) | No |
| Plan | Free text: catalysts, levels, limits for the day | Yes |

**Plan written** = a feeling, energy, where, the market, and the plan. `planned_at` is stamped while it's true.

### Focus list

The tickers you're watching for the day, in the premarket after the market and before the plan.
Type the ticker and + Add (or Enter); it opens with its charts, and the rest is optional:

| Part | What |
|---|---|
| Charts | The missed trades' charts: the ticker's 5 minutes that day and its daily, the day marked 'focus' |
| Side | Long, Short |
| Setups | My setups as chips, the ones on first, then most used; any number on at once (six at most), named in the side's words; + New setup makes one ('New setup for QCOM on your focus list') |
| Note | One line, up to 500 characters: levels, the trigger, what you're waiting for |
| Screenshots | Like a missed trade's: Paste from clipboard, + Add screenshot, or paste or drop one anywhere on the page while it's open; ten at most |
| How it played | Worked, Failed, Didn't trigger; for after the close, but there any time |
| Review | One line, up to 500 characters: what it did, what you did |

Closed, each is one line: the ticker, side and setups, Traded once a trade on it opened or took P&L that day (a stock's symbol, an option's or a spread's underlying), its note, how it played and how many screenshots it has.
A ticker already on the list opens instead of adding a second one.
Up to 12 a day.
Remove takes one out at once, with Undo on the toast; its screenshots are deleted once Undo can't bring it back (10 seconds).
A missed trade and a focus ticker are never open at once: they share one set of charts.

**In the post-market**, Your focus list lists each ticker with its setups, Traded or Not traded, and How it played as chips, so the review is one tap each.
Tapping a ticker there opens it in the premarket and scrolls to it, for its review line and screenshots.
The focus list never counts toward the plan written or the day reviewed.

### The day

Worked out from the trades, nothing to type: the day's realized P&L, trades with an exit, win rate, trades opened, and each trade that opened or had an exit that day (its P&L that day, R, reviewed or not), each opening its trade page. Links: The day's trades (the Trades list narrowed to the day) and The day's stats. No filters apply: it's the whole day.

### Missed trades

The trades you saw and didn't take, logged any time of the day.
Type the ticker and + Add (or Enter); it opens with its charts, and the rest is optional:

| Part | What |
|---|---|
| Charts | The ticker's 5 minutes that day (regular hours, 8 EMA and VWAP) and its daily (8 EMA, framed 40 sessions before the day through 10 after, the day marked 'missed'), like the trade page's |
| Side | Long, Short |
| Daily setups | My setups as chips, the ones on first, then most used; any number on at once (six at most), named in the side's words; + New setup makes one |
| Entry tactics | The review's entry tactics (6/20, 15-minute pivot, 30-minute pivot and yours) as chips, any number on at once (six at most), like a trade's review; + New adds one |
| Why you missed it | Hesitated, Didn't see it, Away, Too late, Didn't trust it, At my limit |
| Note | One line, up to 500 characters |
| Screenshots | Paste from clipboard, + Add screenshot, or paste or drop one anywhere on the page while it's open; ten at most; the × on one deletes it |

**A setup or tactic you don't have yet:** + New setup (newMissedSetup) opens Edit choices with the new-setup builder on top ('New setup for the missed NVDA'), + New for a level, action or pattern inside it; Add to My setups and NVDA saves it, puts it on the missed trade (onSetupAdded) and closes the sheet.
Parts you already have say 'Already in My setups: …' with Use it, which puts that one on instead.
+ New after the tactics (state.missedNewTactic) takes a name; Add puts it in your library and turns it on for the missed trade, beside any already on, and a name you have (any case) is that one.

Closed, each is one line: the ticker, side, setups, tactics and why, its note, and how many screenshots it has.
The header counts them ('2 missed').

**In the week's review:** the week's and month's review list every trade you missed in them (periodMissed: a week is its Monday through Sunday, like the calendar), after the Trades list, counted by reason ('Hesitated 2 · Away 1'); each line is the notebook's, with its day, and tapping it opens that day with it open (openMissedOnDay).
A week with no trades still shows them under 'No trades this week'.

**Where the charts' bars come from:** the 5 minutes are the journal's kept bars when it has them (a trade of yours in that ticker that day), else Tradier's, read when you open it and never saved, so a day older than about 40 days has no 5-minute chart.
The daily is Tradier's last year.
Both need a Tradier key; without one each says so.
One missed trade is open at a time, so there's one set of charts; filling it in keeps them on the view you left.
Remove takes one out at once, with Undo on the toast; its screenshots are deleted once Undo can't bring it back (10 seconds).
Up to 20 a day.
They never count in P&L, stats, the plan or the review.

### Post-market

| Part | What | Required |
|---|---|---|
| Day grade | A, B, C, D, F (the trade's setup grade scale) | Yes |
| Your rules | Kept or Broke for each rule that applies to the day | Every one |
| Kept your last focus? | Yes, partly, no | Shown only when there's a last focus; never required |
| What went well | Note | This or What to work on |
| What to work on | Note | This or What went well |
| More notes | Anything else about the day (`journal_days.note`, the day note the first review migration made and nothing wrote) | No |
| From today's trades | The exit notes on the day's trades, to read; a trade without one links to its review | Nothing to fill in |
| Tomorrow's focus | One line (it wraps as you type), shown at the top of the next plan | No |

**Day reviewed** = the grade, every rule answered, and one of the two guided notes. `reviewed_at` is stamped while it's true.

**Which rules apply to a day:** the rules you had then (made on or before it, `settings.since`) that aren't retired, plus any rule answered that day even if it's retired since. A rule you add today doesn't ask about last week.

## Goals and rules

- Rows in `library_items`, kinds `goal` and `rule`, so each has a stable id (`mine:<uuid>`) and rewording one keeps its history. `settings` holds `{ order, since }`: the list order and the New York day it was made.
- Edit on each list opens it in place: reword, move up or down, Retire (hidden: it leaves the list and the daily check, its answers stay), and + Add. Up to 20 of each, 200 characters each.
- They start empty: they're yours to write.
- **Rules can carry a number** (slice 2), for the app to check after the close and pre-fill with its reason, which you confirm or change: a daily max loss as a % of the account (`{ check: 'max_loss_pct', value: 5 }`), oversizing against your max loss per trade, and a loss past −1R (didn't follow the stop).

## Data

Migration `20261031000000_day_notebook.sql`:

- `journal_days` gains `feelings` (jsonb array of keys), `energy` (rested | ok | tired), `sleep_hours` (0 to 24), `place` (desk | phone), `plan`, `focus_list` (jsonb array, for slice 2), `grade` (A to F), `rules` (jsonb object: rule key → kept | broke), `went_well`, `work_on`, `focus_next`, `focus_kept` (yes | partly | no), `planned_at`, `reviewed_at`. `note` stays the day's free note.
- `library_items` accepts kinds `goal` and `rule`, and names up to 200 characters (goals run longer than a chip's name; the app keeps other items at 80).

The new columns are read on their own query, so before the push the rest of the review works and the notebook says it needs `npx supabase db push`.

Migration `20261105000000_focus_list.sql`:

- `journal_days.focus_list` (the notebook's migration made it, empty until now) holds `[{ id, symbol, side, setups, note, played, review }]`, cleanFocusList on the way in.
- Its size limit grows from 8000 bytes to 30000, for 12 tickers with full notes; before the push a list over the old limit doesn't save and says why.
- Screenshots are `trade_shots` rows keyed `focus:<its id>`.

Migration `20261104000000_missed_trades.sql`:

- `journal_days` gains `missed` (jsonb array of `{ id, symbol, side, setup, tactic, why, note }`, cleanMissed on the way in).
- Screenshots need no new table: they're `trade_shots` rows like a trade's, `trade_key` = `missed:<its id>`, the files in the same private bucket.
- Read on its own query too (MISSED_COLUMNS), so before that push the notebook works and only the Missed trades section says it needs `npx supabase db push`.

**Saving:** like the trade and week reviews. The missed trades save as one list, like any other field. Each choice upserts only its own columns on (user, day), shown at once, put back with a toast if Supabase refuses. Text is a draft while you type and saves when the box loses focus. `planned_at` and `reviewed_at` go with the save that flips them.

## Slices

1. **The day page (built):** the calendar opens it, today's line, the marks; premarket (last focus, check-in, goals, rules, market, plan); the day's numbers and trades; post-market (grade, rules, kept the focus, the three notes, the day's exit notes, tomorrow's focus); goals and rules with their editor; the migration.
2. **Focus list and the app's checks:** the focus list (built: tickers with their setups, charts, screenshots, how each played, traded or not); trades tagged on plan or off plan (their underlying was on the list), P&L on plan against off it; the three rule checks pre-filled with their reason; numbers beside goals the app can measure (days you kept every rule, your streak of plans written).
3. **Stats and the week review:** results by feeling, energy and where you traded; each rule's kept rate and P&L on days kept against broken; the week review's Preparedness (plans written), Emotional control (the check-ins), Execution consistency (rules kept), and the week's What to work on notes together. Day screenshots (trade_shots keyed `day:YYYY-MM-DD`), and "Review the day" after the review deck's last card.

## Open questions

- Whether a focus you keep writing should become a rule (an "Add to my rules" button on it).
- NYSE holidays: the page steps through every weekday, holidays included, like the calendar.
