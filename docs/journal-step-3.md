# Step 3: reviewing trades

Status: slice 1 (review on the trade page) built. This is the next part of [the journal plan](journal-plan.md), after [step 2](journal-step-2.md), which builds trades, their charts and the stats from Schwab.

## Goal

Every trade gets reviewed: what the market and its sector were doing, which setups and entry tactic it was, how good the setup was, whether you followed your plan, and what you think now. Reviewing has to be quick enough that it actually happens, so it lives on the trade page first and in a swipe-through deck next. The app's guesses come after that, and the stats can then be cut by any label.

## Principles

1. **Labeling works by hand before anything guesses.** Guesses come later, each in its own slice, and you always confirm or fix them.
2. **Labels are facts about a trade, kept apart from its numbers.** They point to the trade's key (`trade:<id>` for a trade you shaped, otherwise account, symbol, direction and open time), the way your stop and deletes already do, so re-imports and fixes to the math never detach them.
3. **One library of choices.** It has defaults everyone gets, plus your own additions. You can hide, rename, or merge (an alias remembers the old name), and what you've labeled stays labeled.
4. **Every slice is something you can use.**

## Decisions

- **Two grades per trade:**
  - **Setup grade:** A++, A, B, C, D, F. How good the setup and execution were.
  - **Followed the plan:** yes, partly, no. Discipline, apart from whether the setup was good.

  The by-grade report checks the ladder: if A trades don't beat C trades, the grading isn't telling you anything.
- **A trade is reviewed when it has:** market, sector, at least one daily setup, an entry tactic, both grades, and a note. Tags and mistakes are optional. Until then it counts as "to review".
- **Labeling starts on the trade page.** The deck in slice 2 reuses the same pieces.
- **The app's guesses come after manual labeling works** (slice 3). A guess shows its reason and who set it ("you" or "the app").
- **Market is set once per day.** Every trade that day inherits it, and you can override a single trade.
- **Options and spreads are labeled on their underlying:** the setups and sector are the stock's. A spread is one trade with one set of labels.
- **No AI.** Notes are yours, and dictation keeps them fast.

## The labels

Defaults, in the app's code (`src/core/journal-labels.js`). Your additions live in your account.

| Label | Per trade | Defaults |
|---|---|---|
| **Market** | 1, set per day | Bullish, Neutral, Bearish, Choppy |
| **Sector** | 1 | Strong, Weak, Neutral, N/A |
| **Daily setup** | Any number, all equal | A level plus an action, or a pattern (below) |
| **Entry tactic** | 1 | 6/20 (Gil Morales), 15-minute pivot, 30-minute pivot |
| **Tags** | Any number | Option flow, which takes links to the trade's flow (Unusual Whales, Bullflow) |
| **Mistakes** | Any number | Chased the entry, Oversized, Moved the stop, Revenge trade, Exited early, Didn't take the stop |

**Daily setups**
- **Levels:** 50, 100 and 200 SMA; 8 and 21 EMA; support; resistance; AVWAP from the all-time high, the all-time low, and earnings.
- **Actions:** bounce, undercut and rally, rejection.
- **Patterns:** base breakout, pennant or flag breakout, earnings gap.
- **My setups:** each setup is saved once and picked from then on. It's an action (bounce, undercut & rally, rejection) at one or more levels ("21 EMA bounce", "50 SMA + support undercut & rally"), or a pattern ("Base breakout"). The list starts with nine; you add one with "+ New setup" when nothing fits.
  - **Search first:** picking what happened and the levels narrows My setups to the ones that fit. One you already have says so, and only a new combination gets saved.
  - **Reports** can cut by setup, by action (every bounce), or by level (everything at the 21 EMA), since each setup keeps its parts.
- **Counting:** a trade counts toward each of its setups, so the setup report's rows don't add up to the total. The report says so.

**Entry tactics:** the pivot rules are in [the journal plan](journal-plan.md#labels). They matter in slice 3, when the app guesses.

## Data

Every table has row-level security (`user_id = auth.uid()`), nothing is granted to `anon`, and `tests/rls.test.mjs` checks each one. A new migration goes after the baseline, never as an edit to it.

| Table | One row per | Holds |
|---|---|---|
| `trade_reviews` (exists) | Trade | Adds `setup_grade` (A++ to F), `plan_followed` (yes, partly, no), `note`, `market` (a per-trade override of the day's), and `reviewed_at` (set when the required fields are all there) |
| `trade_labels` | Label on a trade | Trade key, `kind` (sector, setup, tactic, tag, mistake), `value` (an item key, e.g. `sma50+bounce` or `mine:<id>`), `set_by` (you or the app), and for a guess its reason and confidence |
| `journal_days` | Trading day | `day` (New York), `market`, a day note |
| `library_items` | Item of yours, or a change to a default | `kind`, `name`, `default_key` (when it renames or hides a default), `hidden`, `merged_into` (an item key, which is how aliases work), and settings like a pivot's minimum reds |

- **Item keys are stable:** `sma50`, `bounce`, `pivot15`, `mine:<uuid>`. Renaming changes only the name.
- **Merging** points the old key at the new one. Past labels resolve through it, so nothing is rewritten.

## Slices

### 1. Review on the trade page (built)

- **A Review section** on the trade page, under the stats:
  - market (the day's, with "this trade only")
  - sector
  - setups (pick a level, then an optional action, or a pattern)
  - tactic, tags, mistakes
  - both grades, and the note
- **Chips for quick picks.** "+ New" adds your own item in place.
- **Saves as you go.** It shows "Reviewed" once the required fields are in, and "To review: missing sector, note" until then.
- **The trades list** gets a reviewed or to-review mark and a "To review" filter.
- **A Library sheet** to rename, hide and merge.

### 2. The review deck

- **"Review N trades"** from the Journal, and a banner above the risk strip ("N trades to review") that never blocks anything.
- **Cards:** one per trade, oldest unreviewed first, with the same charts and Review section. Swipes on the phone, arrow keys on desktop.
- **P&L is hidden until you grade.** A setting can show it up front.
- **Swings get two passes:** labels and plan when they open, the grade and note when they close.
- **Gestures (proposed):** right = done, left = back, up = save for the weekly review.

### 3. Guesses

Each part ships alone, tested on your saved bars:
1. **Entry tactic:** the 15 and 30-minute pivot, and 6/20 on 5-minute bars at the entry time.
2. **Daily setups:** whether the entry was near a level (within a set distance of the SMA, EMA or AVWAP), the action from the bars before it, and gaps.
3. **Market** from SPY and QQQ, and **sector** from the stock's group ETF. This needs a hand-checked map from the Market tab's 146 industry groups to its 88 group ETFs, falling back to the S&P sector ETF.

Low-confidence guesses come first in the deck.

### 4. Mistake flags

- **Caught automatically:**
  - **Oversized:** risk over the planned risk.
  - **Moved the stop:** the first stop was replaced farther away.
  - **Revenge trade:** entered within minutes of a loss.
  - **Exited early:** closed before both the stop and a target.
- **You dismiss the wrong ones.** The cutoffs are set in this slice.

### 5. Reports by label

- **The Stats tab's tables, cut by** setup, tactic, market, sector, grade, plan followed, tags and mistakes, with the same stats and thin rows.
- **Grade ladder:** A against C.
- **Followed the plan or not:** compared like LuxAlgo's playbook rules.
- **Combinations:** a setup in a bullish market, for example.

### 6. Weekly review and goals

- **The week in one card:** your costliest mistake (in R), your most consistent edge, and one rule for next week.
- **Goals** for win rate, profit factor, expectancy and exit efficiency, with the dashboard measured against them.

## Open questions

- **Market guess rule:** SPY and QQQ against which moving averages, and what counts as choppy (slice 3).
- **Sector guess rule:** relative strength of the group ETF against SPY over which window (slice 3).
- **Mistake cutoffs:** how many minutes counts as revenge, how far over plan counts as oversized (slice 4).
- **Deck gestures,** and whether P&L hides by default (slice 2).
- **Emotions as their own label** (fear, FOMO, calm), or just tags.
