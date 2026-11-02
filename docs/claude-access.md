# Claude access

A Claude Code session can read your journal, save trade reviews and add to your Model books, with a key you make in the app.
You say what happened ("mark the QQQ put a lotto, I broke my VWAP stop") and the session saves the review the way the trade page would.
You say how the day went and it saves the day's review in the notebook the way the day page would.
You hand it a chart ("put this in Best longs as a 21 EMA bounce") and it adds the example the way Model books would.
It can't reach anything else: not your settings, your Tradier key, your Schwab login or another account's rows.

## The key

Settings has a **Claude access** section while you're signed in (src/ui/claude-access.js, src/services/claude-keys.js).
**Make key** draws 32 random bytes in the browser (`scj_` and base64url) and saves only their SHA-256 in `claude_keys` (migration 20261103000000_claude_access.sql).
The key is shown once, with Copy (its toast says "your Claude key", not the key), and forgotten when any sheet opens or closes.
Each key lists when it was made and last used; **Revoke** deletes its row, and the next call with it is refused.
A database without the migration says so in the section.

## What a key can do

Four database functions take the key in place of a sign-in, and they're the only thing the anonymous role may run (tests/rls.test.mjs allows these alone and checks each starts with the key check).
`claude_key_user` turns a key into its owner and stamps last_used_at; nobody can call it directly.
`claude_journal_read` returns that owner's records (the newest 5000, as the Journal reads them), shaped trades, reviews, labels, each day's market and the library.
It returns the order plans too (migration 20261107000000_order_plans.sql redefines it), and `show` prints a trade's under 'order plan:' the way the trade page does (docs/journal.md), for analyzing risk as a % of the account and how stops were set.
`claude_journal_save` writes, in one transaction: your own library items, review fields (stop, setup grade, plan followed, exit note, entry note, the trade's own market, reviewed_at; nothing else, so it can't delete a trade), labels off and on, and a day's market.
Migration 20261114000000_claude_day_review.sql redefines both: the read returns every day's row with its review fields, and the save writes a day's review (the grade, each rule kept or broke, what went well, what to work on, more notes, tomorrow's focus, whether the last focus was kept, reviewed_at).
Migration 20261115000000_claude_week_review.sql redefines them again: the read returns every week's and month's review (`periods`, the period_reviews rows), and the save writes one (each part's grade and note, what went well, what to work on, more notes, the rule for the next period, whether the last one's was kept, reviewed_at).
Migration 20261116000000_week_rules.sql redefines them once more: the read returns each day's check-ins on its week's rules (`week_rules`) and each review's rules list, Kept it? on each and how they went (`rules_next`, `rules_kept`, `rules_note`), and the save writes them (week_rules and rules_kept merge one rule at a time, a null clears one; rules_next is replaced whole).
The rest of the notebook (the premarket plan, the check-in, the focus list, the missed trades) stays out of reach.
Rule answers merge one rule at a time, and a null answer clears that rule's.
`claude_model_books_read` (migration 20261108000000_claude_model_books.sql) returns that owner's books, examples (no image links) and library.
`claude_model_books_save` makes and renames books and edits an example's title, notes, setups and book; it can't delete either, and a new example only comes with its screenshot, below.
Every row it touches is the key owner's; the tables' own checks still apply.

## Model books screenshots

A screenshot goes to Storage, and SQL can't upload a file, so new examples go through the `claude-model-example` Edge Function (`supabase/functions/claude-model-example/`).
`handler.js` is the whole of it, plain JS with no imports so Node's tests load it; `index.ts` only hands it Deno's request and environment.
It reads the image itself: PNG, JPEG or WebP by its first bytes, 2 MB at most (the app's limit), its width and height from its own header, never the caller's word.
Then it calls `claude_model_example_add` with the key, which checks the key and adds the row in the owner's book at the path the app uses (`<owner>/<id>.<ext>`).
That function is the service role's alone (revoked from anon and signed-in users; tests/rls.test.mjs checks it), so the row only ever comes with a checked image.
Then it uploads the file to the `model-books` bucket with the service role; if Storage refuses, it deletes the row again and says why.
A wrong key or a bad image never reaches Storage.
The function runs with `--no-verify-jwt`: the Claude key stands in for a sign-in, so the gateway's JWT check is off and the handler checks the key.
It reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase gives every function; a `sb_secret_` key goes as the apikey alone, a legacy service_role JWT as the bearer too.

Anyone holding a key can rewrite that account's trade, day, week and month reviews and labels and add to its model books, so keep it in the environment's secrets, never in a chat or a file in the repo.

## Setting up a Claude Code environment

In the app: sign in, Settings, Claude access, Make key, Copy.
In the Claude Code environment's settings (the environment menu in the session's title bar, then Edit): add `dhohfavttsxwutanvcuj.supabase.co` under network access (Allowed domains, package managers left on), and the key as the `JOURNAL_KEY` secret.
New sessions in that environment pick both up.

Once per project, from a checkout: `npx supabase db push` for the migrations, then `npx supabase functions deploy claude-model-example --no-verify-jwt` for the screenshot function (add `--use-api` if Docker isn't running).

## Reviewing by talking

A review is the owner's own assessment, so a session writes it by asking, not by drafting (owner request, after a session filled a day's notes with its own reading of the fills).
First pull what's there (`show`, `day`, `week` or `month`) and say in a line or two what's filled and what's missing.
Then ask the page's questions, a part or two at a time, in the page's words: for a trade its market, sector, setups, tactics, mistakes, grade, plan followed and notes; for a day the last focus, the grade, each rule kept or broke, each of this week's rules kept or broke, what went well, what to work on, more notes and tomorrow's focus; for a week or month the rules last one set (how the days went with each, Kept it? on each, then how they went, in the owner's words), each part's grade and note, the notes and the rules for next one.
Ask only for what's missing, and leave what the owner already filled in unless they want to change it.
For choices (setups, tactics, mistakes, the market) offer the owner's own names from `choices`.
Save their answers in their voice, tidied only for spelling and punctuation.
Numbers or patterns from the fills go in the chat when they help the owner answer, never into the notes unless the owner asks for them there.
Show the dry run, and save once the owner says yes.

## The script

`scripts/journal.mjs` (Node, no packages) calls the Claude functions with `JOURNAL_KEY` and runs the app's own `src/core` journal code on what comes back, so trades, keys and numbers match the Journal.
It turns Node's proxy support on for itself when HTTPS_PROXY is set (a cloud session's traffic goes through one).
Logic is in `scripts/journal-lib.mjs`, pure, tested in tests/claude-access.test.mjs; `.assetsignore` keeps `scripts/` off the app host.

- `node scripts/journal.mjs trades [--symbol QQQ] [--day 2026-10-23] [--todo] [--open] [--limit 20]`: one line per trade, newest first, starting with its handle (`t` and 7 hex of the key's SHA-256).
- `node scripts/journal.mjs show <handle or key>`: the numbers, the fills and the review in words, with what's missing.
- `node scripts/journal.mjs choices [kind]`: your choices with their keys.
- `node scripts/journal.mjs review <handle or key> '<json>' [--dry-run]`: saves a review and prints the trade after; a dry run prints the changes instead.
- `node scripts/journal.mjs day <YYYY-MM-DD> ['<json>'] [--dry-run]`: without JSON, the day: its market, P&L, trades, and its review (this week's rules numbered) with what's missing; with it, saves the day's review and prints the day after.
- `node scripts/journal.mjs week <any day of it> ['<json>'] [--dry-run]` and `month <YYYY-MM> ...`: without JSON, the week (by its Monday) or month: its P&L from the exits taken in it, its trades, the rules the last one set (numbered, how the days checked each, Kept it?, how they went), each part's grade and note and the rules for next one with what's missing; with it, saves the review and prints it after.
- `node scripts/journal.mjs books [book]`: every book (or one) with its examples, newest first, each with its handle (the first 8 of its id), then the examples in no book.
- `node scripts/journal.mjs book [book] '<json>' [--dry-run]`: makes a book (`name`, `description`), or changes the one named.
- `node scripts/journal.mjs add-example <image file> '<json>' [--dry-run]`: adds an example with its screenshot (`title`, `notes`, `setups`, and `book` if you want one).
- `node scripts/journal.mjs example <handle> '<json>' [--dry-run]`: changes an example's `book`, `title`, `notes` or `setups`.

A review's JSON takes `market`, `marketFor` ('day' or 'trade'), `sector`, `setups`, `tactics`, `tags`, `mistakes`, `grade` (A to F), `plan` (yes, partly, no), `entryNote`, `exitNote` and `stop`; fields left out stay, null clears one.
Names match your choices in either side's words ("N/A", "Didn't take the stop", "Pennant or flag breakdown") or by key.
Each label kind given is set to exactly those; a name that isn't one of yours is added to your choices, and a setup that isn't one becomes a pattern of that name and the setup made of it, as + New setup does.
The market goes on the trade's day, unless the day already has another (then it's the trade's own and the script says so), or marketFor says otherwise.
reviewed_at is stamped once everything a review needs is in, and cleared if something comes off.

A day's JSON takes `grade` (A to F), `rules` (`{ "Follow your stops": "broke" }`, each rule by its name or key, `kept`, `broke` or null), `weekRules` (`{ "No trades before 9:45": "kept" }`, each of this week's rules by its text or number, `kept`, `broke` or null), `wentWell`, `workOn`, `note`, `focusNext` and `focusKept` (yes, partly, no); fields left out stay, null clears one.
Only the rules that apply to the day can be answered (made on or before it and not retired, or answered already), as the day page asks; any other name is refused with the day's rules.
The day's reviewed_at is stamped once it has a grade, every rule that applies, each of this week's rules and what went well or what to work on, and cleared if one comes off.

A week's or month's JSON takes `parts` (`{ "Risk management": { "grade": "D+", "note": "..." } }`, each part by its name or key: selection, entry, exit, risk, emotion, market, prep, consistency; grades A+ to F), `wentWell`, `workOn`, `note`, `rulesNext` (the whole list, up to 5 rules of 500 characters; a rule already on it keeps its id), `rulesKept` (`{ "1": "partly" }`, each of the rules the last period set by its text or number: yes, partly, no or null, saved on this period's row as the page does) and `rulesNote` (how they went); fields left out stay, null clears one.
Its reviewed_at is stamped once every part has a grade, the rules for next one are set and, when the last period set a list, each has its Kept it? and how they went is said; cleared if one comes off.

Model books logic is in `scripts/model-books-lib.mjs`, pure, tested in tests/claude-model-books.test.mjs with the function.
A book is optional: left out, a new example goes in no book, and `"book": null` takes an example out of its book.
A book is named by its name or handle; an example's `book` that isn't one of yours is made.
`setups` are matched the way a review's are, a new one added to My setups (saved first, through claude_journal_save); the list given replaces the example's, and null clears it.
An example's title is 1 to 120 characters and its notes 4000 at most, as in the app.
The script checks the image before sending it (the function's own reader), and a screenshot over 2 MB has to be shrunk first (`sips -Z 2000 -s format jpeg in.png --out out.jpg` on a Mac).
If the upload fails after a new book or setup was saved, those stay.
