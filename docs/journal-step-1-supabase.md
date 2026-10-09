# Step 1: Supabase and sign-in

Status: built. This is phase 1 of [the journal plan](journal-plan.md).

**Update (2026-10-09):** `main` retired saved position cards while this step was being built. Positions now shows live Schwab positions. So this step syncs settings and the Tradier key only. The `saved_positions` table created by the first migration is dropped by `20261009010000_drop_saved_positions.sql`, and leftover saved-position keys on older devices are never sent. Everything below about saved positions describes the original plan.

## Outcome

- **Signed in:** sign in with Google from Settings, and your settings, Tradier key, and saved positions follow you across devices through Supabase.
- **Signed out:** the calculator works exactly as today, on this device only.
- **The old encrypted Cloudflare sync is removed** in the same change.
- **Nothing journal-specific yet.** This step only moves what the app stores today.

## Decisions

- **Signed out:** the calculator works without signing in, and signing in adds sync.
- **First sign-in on a device:** the cloud's settings win, and saved positions from both are combined.
- **Old sync:** removed right away, not run alongside.
- **Signing out:** clears the synced data from the device.
- **Supabase's library:** a pinned, bundled copy committed to the repo, loaded only when it's needed.
- **From the plan:**
  - the Tradier key is kept in Supabase Vault
  - row-level security is on every table
  - the app stays on GitHub Pages

## What you set up

I can't create accounts or enter credentials, so these are yours.

1. **Supabase project:**
   - Create one on the free plan, in a region near you, named `size-calc`.
   - Keep the database password in your password manager. The app never needs it, and neither do I.
2. **Google OAuth client** (Google Cloud Console):
   1. Create a project.
   2. Set up the OAuth consent screen: external, app name, your support email, and only the `openid`, `email`, and `profile` scopes.
   3. Under Credentials, create an OAuth client id of type Web application:
      - authorized JavaScript origins: `https://aolfat.github.io` and `http://localhost:8765`
      - authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
   4. While the consent screen is in Testing, only listed test users can sign in. Add yourself, and publish it before inviting anyone.
3. **Turn on Google in Supabase:** Authentication, Sign In / Providers, Google. Paste the client id and secret there.
4. **Supabase addresses** (Authentication, URL Configuration):
   - site URL: `https://aolfat.github.io/size-calc/`
   - redirect URLs: that address and `http://localhost:8765/**`
5. **Vault:** check that the `supabase_vault` extension is on, under Database, Extensions.
6. **Send me two things:** the project URL and the publishable key, both from Project Settings. They're public by design. Never send the secret key.

## What moves where

| On the device today | Goes to |
|---|---|
| `calc_account`, `calc_risk`, `calc_allocation`, `risk_usd_presets`, `atr_multiplier`, `stop_strategy`, `stop_percent`, `last_ticker`, `tradier_env` | The `settings` table, one row per key |
| `tradier_key` | Vault, through three database functions |
| `saved_positions` | The `saved_positions` table, one row per position |
| `deleted_positions` (delete markers) | A `deleted_at` time on that table's rows. Kept on the device too, for backup-file merges |
| `sync_id`, `sync_key`, `sync_dirty`, `last_sync_t` | Deleted from the device |

Everything else stays on the device, as it does today: the Schwab login, chart preferences, recent tickers, and Market caches.

## Tables (migration `20261009000000_settings.sql`)

**`settings`**
- **Columns:**
  - `user_id`: defaults to the signed-in user, deleted with the account
  - `key`: limited to the nine keys above, plus `tradier_key_at`
  - `value`, as text
  - `updated_at`, set by the server
- **Primary key:** the user and the key.

**`saved_positions`**
- **Columns:** `user_id`, `id` (the existing `saved_<ms>` id), `data` (the card, as JSON), `updated_at`, and `deleted_at` (empty unless deleted).
- **Primary key:** the user and the id.
- **Temporary.** It goes away once open trades come from imported fills.

**For both tables**
- **Server time:** a trigger sets `updated_at` to the server's time on every write, so device clocks never decide anything.
- **Row-level security** is on. One rule covers every operation: a row is visible and writable only when its `user_id` is the signed-in user.
- **Access:** granted to signed-in users only, with nothing for the anonymous role.

**Tradier key functions**
- **The three functions:**
  - `set_tradier_key(key)` stores the key
  - `get_tradier_key()` returns it
  - `clear_tradier_key()` removes it
- **How they're secured:**
  - Each one finds the signed-in user's secret by user id.
  - They run with elevated rights and a fixed search path, so the app never touches Vault directly.
  - Only signed-in users can call them.
- **Telling other devices:** `set_tradier_key` also updates `tradier_key_at` in `settings`. That's how another device knows to fetch the new key without asking for it on every check.

## Sign-in flow

1. Settings, Account, **Sign in with Google**.
2. The app loads Supabase's library and starts Google sign-in. It asks to come back to the app's address with `?login=google` added.
3. Google sends you back through Supabase to the app, with `?login=google&code=…`.
4. On load, the app sees `login=google`, swaps the code for a session, and removes the query from the address bar.
   - **Two callbacks share `?code` today, so each one checks its own marker first.** The Schwab handler ignores any address with `login=google`, and the Supabase handler ignores any address without it. Without that check, the Schwab handler (`initSchwab`) would strip Google's code before Supabase could use it.
5. The library keeps the session in the browser and refreshes it automatically. You stay signed in until you sign out.
6. On a device's first sign-in, the move below runs.

## First sign-in on a device

1. Read the cloud: settings rows, saved positions, and whether a Tradier key exists.
2. **If the cloud has no settings** (the first device ever):
   - Upload this device's settings.
   - Upload its Tradier key into Vault.
   - Upload its saved positions, skipping any with a delete marker.
   - Toast: "Signed in. Saved this device's settings to your account."
3. **If the cloud has settings:**
   - **Settings:** the cloud's replace this device's.
   - **Tradier key:** use the cloud's if there is one. Otherwise upload this device's.
   - **Saved positions:**
     - The two sets are combined.
     - A position deleted in the cloud is removed here.
     - A position with a delete marker here is marked deleted in the cloud.
     - A position only this device has is uploaded.
   - Toast: "Signed in. Loaded your settings from your account."
4. Delete the old sync keys from this device.

The merge is a pure function with its own tests.

## Ongoing sync while signed in

- **Saving:**
  - Every change still goes through `store.set`, and its existing hook now tells the new cloud module instead of the old sync.
  - Changed keys are marked pending and saved on the device, then written together 2.5 seconds after the last edit.
  - Positions are written by id. A delete sets `deleted_at`.
  - A Tradier key edit calls `set_tradier_key`.
- **Checking for changes:** happens on load, when the window regains focus, when you return to the tab, and every 60 seconds while visible.
  - Each check asks only for rows changed since the last one, then applies them without a reload. The ticker you loaded stays put.
  - An edit not yet sent wins over what comes back.
- **Conflicts:** for each key, and for each position, the last write to reach the server wins.
- **Offline:** pending edits stay saved on the device and go out on the next check.
- **Status:** the Account section says "Saving…", "Synced 9:41", or "Offline, will retry". An expired session says "Sign in again".

## Signing out

- Pending edits are sent first. If you're offline, the app warns you before signing out.
- **Signing out clears the synced data from this device.** Settings go back to defaults, and the Tradier key and saved positions are cleared, so a shared computer doesn't keep your key. The calculator still works signed out, and signing back in restores everything from the account.

## Screens

**Settings sheet, a new Account section at the top**
- **Signed out:** a **Sign in with Google** button. Hint: "Sync your settings, key, and positions across devices. The calculator works without signing in."
- **Signed in:** "Signed in as you@gmail.com", the status line, and a **Sign out** button.

**Elsewhere in Settings**
- **Tradier key hint:**
  - signed in: "Saved to your account, encrypted. Requests go straight to Tradier."
  - signed out: today's text
- **The status line under the key** says "Signed in" where it said "⇄ Sync on".
- **The sync passphrase section is removed.**
- **The Backup section is unchanged.** The export still includes the key.

Copy follows the house style: sentence case, short, no em dashes.

## Code changes

**New**
- `vendor/supabase.js`: the pinned bundle, with its version noted at the top and in CLAUDE.md.
  - **Outside `src/` on purpose.** The test harness loads every module under `src/` and scans them for element ids, so the bundle must not live there.
  - **Loaded with `import()`** only when you sign in or a session already exists. A signed-out app never downloads it.
- `src/services/supabase.js`: the project URL and publishable key, loading the library, sign in, sign out, the session, and sign-in changes. No UI imports.
- `src/services/cloud.js`: replaces `sync.js`.
  - Pending keys, saving, checking for changes, the Tradier key functions, and the first-sign-in move.
  - Its `onCloudView` hook replaces `onSyncView`.
- `src/core/cloud-merge.js`: the pure merge rules, with `@ts-check`.
- `supabase/migrations/20261009000000_settings.sql`: tables, row-level security, triggers, and the Vault functions.
- `tests/cloud.test.mjs`: uses a fake Supabase client passed in through the harness.
- `tests/rls.test.mjs`: reads the migration files. It fails on any table without row-level security and an owner rule, and on any grant to the anonymous role.

**Changed**
- `index.html`: the Account section is added, and the sync section is removed.
- `src/ui/settings.js`: the account section replaces the passphrase UI. The function that re-reads storage after a remote change stays, renamed.
- `src/ui/actions.js`: `signIn` and `signOut` are added, and `toggleSync` and `syncPassEnter` are removed.
- `src/ui/trade.js`: `initSchwab` ignores addresses carrying `login=google`.
- `src/state.js`: the sync fields are removed. `session`, `cloudPending`, `cloudBusy`, and `cloudTimer` are added.
- `src/main.js`: on boot, finish a Google return, then check for changes. Focus and returning to the tab check too.
- `src/lib/store.js`: the comment only. Its write hook now feeds the cloud module.
- `tests/helpers/app.mjs`: an option to pass in a fake Supabase client.
- `CLAUDE.md`:
  - The Supabase architecture replaces the sync bullet.
  - It notes the one-dependency exception.
  - It adds the local sign-in redirect for `localhost:8765`.

**Removed**
- `src/services/sync.js` and `tests/sync.test.mjs`.
- The sync worker: `worker/worker.js`, `worker/wrangler.toml`, and `worker/README.md`. The Schwab worker in `worker/schwab/` stays.
- **Your task after both devices have moved:** delete the deployed sync worker and its KV namespace in Cloudflare. Until then the old encrypted copy just sits there, and it expires after 400 days without a write.

## Tests

- **Merge rules:**
  - an empty cloud
  - a cloud that already has data
  - combining positions
  - deletes in both directions
  - local delete markers
- **Cloud module:**
  - pending keys are sent after the pause
  - changes from the server don't mark anything pending
  - pending edits survive a failed save
  - signing out clears the device
- **Sign-in return:**
  - an address with `login=google` goes to Supabase, and the Schwab handler leaves it alone
  - Schwab's own callback still works
- **Row-level security:** the check that reads the migration files.
- **Existing tests:** the actions test already fails if a new button's action has no handler.
- **By hand:**
  - Sign in on the Mac and the iPhone, change risk on one, and see it on the other within a minute.
  - Delete a saved position and see it disappear on the other device.
  - Sign out and confirm the key is gone.
  - Sign in with a second Google account and confirm it sees nothing.

## Rollout

1. You: set up the Supabase project, the Google client, and the addresses. Send me the project URL and publishable key.
2. Me: build it all on a branch and run the tests. Then test sign-in locally at `localhost:8765`. You do the Google sign-in in the browser, since I can't enter your Google credentials.
3. Before merging: make sure both devices are in step under the old sync.
4. Merge. GitHub Pages deploys.
5. Sign in on the computer first, which fills the cloud, then on the phone, which adopts the cloud and combines positions.
6. Delete the sync worker and its KV namespace in Cloudflare.

## Risks

- **The two `?code` callbacks clashing:** handled by the `login=google` marker.
- **A wrong or missing row-level security rule:** caught by the migration check and the second-account test.
- **The free plan pausing after a quiet week:**
  - Requests fail until you restore the project in the dashboard.
  - Meanwhile the app says "Offline" and keeps working on the device.
- **Library size:** loaded only when signed in.
- **Google's Testing mode:** only listed test users can sign in. Publish the consent screen before inviting others.
- **Google's sign-in page will likely name the Supabase project address** (`<project-ref>.supabase.co`) rather than the app. Supabase's custom domains, a paid add-on, would fix that. It's cosmetic.
- **Same key edited on two devices:** the last write to arrive wins. That's fine for settings.

## Later

- **A Delete my account button:** not in this step. Build it before inviting anyone else. For you alone, the Supabase dashboard can delete everything.
  - **Why it needs server code:** the app can delete its own rows, but removing the sign-in account needs Supabase's admin rights. The admin key must never reach the browser, so this takes an Edge Function, or a locked-down database function that deletes only the caller.
  - **The Tradier key in Vault isn't linked to the user record,** so the delete has to clear it explicitly.
