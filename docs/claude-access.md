# Claude access

A Claude Code session can read your journal and save trade reviews, with a key you make in the app.
You say what happened ("mark the QQQ put a lotto, I broke my VWAP stop") and the session saves the review the way the trade page would.
It can't reach anything else: not your settings, your Tradier key, your Schwab login or another account's rows.

## The key

Settings has a **Claude access** section while you're signed in (src/ui/claude-access.js, src/services/claude-keys.js).
**Make key** draws 32 random bytes in the browser (`scj_` and base64url) and saves only their SHA-256 in `claude_keys` (migration 20261103000000_claude_access.sql).
The key is shown once, with Copy (its toast says "your Claude key", not the key), and forgotten when any sheet opens or closes.
Each key lists when it was made and last used; **Revoke** deletes its row, and the next call with it is refused.
A database without the migration says so in the section.

## What a key can do

Two database functions take the key in place of a sign-in, and they're the only thing the anonymous role may run (tests/rls.test.mjs allows these two alone and checks each starts with the key check).
`claude_key_user` turns a key into its owner and stamps last_used_at; nobody can call it directly.
`claude_journal_read` returns that owner's records (the newest 5000, as the Journal reads them), shaped trades, reviews, labels, each day's market and the library.
`claude_journal_save` writes, in one transaction: your own library items, review fields (stop, setup grade, plan followed, exit note, entry note, the trade's own market, reviewed_at; nothing else, so it can't delete a trade), labels off and on, and a day's market (the notebook on that day stays).
Every row it touches is the key owner's; the tables' own checks still apply.

Anyone holding a key can rewrite that account's reviews and labels, so keep it in the environment's secrets, never in a chat or a file in the repo.

## Setting up a Claude Code environment

In the app: sign in, Settings, Claude access, Make key, Copy.
In the Claude Code environment's settings (the environment menu in the session's title bar, then Edit): add `dhohfavttsxwutanvcuj.supabase.co` under network access (Allowed domains, package managers left on), and the key as the `JOURNAL_KEY` secret.
New sessions in that environment pick both up.

## The script

`scripts/journal.mjs` (Node, no packages) calls the two functions with `JOURNAL_KEY` and runs the app's own `src/core` journal code on what comes back, so trades, keys and numbers match the Journal.
It turns Node's proxy support on for itself when HTTPS_PROXY is set (a cloud session's traffic goes through one).
Logic is in `scripts/journal-lib.mjs`, pure, tested in tests/claude-access.test.mjs; `.assetsignore` keeps `scripts/` off the app host.

- `node scripts/journal.mjs trades [--symbol QQQ] [--day 2026-10-23] [--todo] [--open] [--limit 20]`: one line per trade, newest first, starting with its handle (`t` and 7 hex of the key's SHA-256).
- `node scripts/journal.mjs show <handle or key>`: the numbers, the fills and the review in words, with what's missing.
- `node scripts/journal.mjs choices [kind]`: your choices with their keys.
- `node scripts/journal.mjs review <handle or key> '<json>' [--dry-run]`: saves a review and prints the trade after; a dry run prints the changes instead.

A review's JSON takes `market`, `marketFor` ('day' or 'trade'), `sector`, `setups`, `tactics`, `tags`, `mistakes`, `grade` (A to F), `plan` (yes, partly, no), `entryNote`, `exitNote` and `stop`; fields left out stay, null clears one.
Names match your choices in either side's words ("N/A", "Didn't take the stop", "Pennant or flag breakdown") or by key.
Each label kind given is set to exactly those; a name that isn't one of yours is added to your choices, and a setup that isn't one becomes a pattern of that name and the setup made of it, as + New setup does.
The market goes on the trade's day, unless the day already has another (then it's the trade's own and the script says so), or marketFor says otherwise.
reviewed_at is stamped once everything a review needs is in, and cleared if something comes off.
