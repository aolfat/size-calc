# Account and sync

Google sign-in through Supabase, which settings sync, the Tradier key in Vault, and what happens on sign-in, sign-out and account switches.

- **Account and sync** (optional; the calculator works signed out, on this device only): Settings → Account → **Sign in with Google**, through Supabase Auth (project `dhohfavttsxwutanvcuj`, PKCE).
  Design: `docs/journal-step-1-supabase.md`.
  The redirect comes back to the app's own address with `?login=google&code=…`; `initCloud` swaps the code (`detectSessionInUrl` is off) and strips the query; an old return address opened again (Chrome's history or autocomplete bring it back, its code already spent) resumes the session already on the device instead of showing signed out, and `initSchwab` ignores any address carrying `login=google` (both callbacks use `?code`).
  The session lives in the library's own localStorage key (`sb-<ref>-auth-token`; `hasStoredSession()` checks it without loading the library).
  Signed in, CLOUD_KEYS (calc_account, calc_risk, calc_allocation, risk_usd_presets, atr_multiplier, stop_strategy, stop_percent, last_ticker, tradier_env, schwab_proxy, journal_fees, journal_deck_pnl) live in the `settings` table, one row per key; the Tradier key lives in Supabase Vault through `set_tradier_key` / `get_tradier_key` / `clear_tradier_key` (security definer, fixed search path, the caller's own secret only), and `tradier_key_at` in `settings` tells other devices to fetch it.
  Every table has row-level security (`user_id = auth.uid()`), nothing is granted to anon, and a server trigger stamps `updated_at`.
  Every value-changing store.set on an account key marks it pending (`cloud_pending`, persisted; no-op rewrites and server applies under `cloudSuppress` don't count) and debounce-pushes after 2.5s.
  Pulls re-read from 60s before the newest stamp in `cloud_seen` (a save stamped earlier can commit later; PULL_OVERLAP_MS in core/cloud-merge.js) and skip rows whose per-key stamp they've already seen (so a device with no Tradier key also asks Vault once a page load: a key removed only on the device, as the old github.io block did, leaves no new stamp; state.cloudKeyAsked), on load, focus, visibilitychange and a 60s visible poll (which also retries failed pushes and a session that couldn't load); pending edits win, applied changes rehydrate without a reload (`cloudRehydrate`, keeps the loaded ticker) and toast.
  Last write to reach the server wins per key.
  First sign-in on a device (`cloud_user` ≠ the user): an empty account is filled from this device; otherwise the account's settings and key win, and a setting only this device has is uploaded.
  A device last bound to ANOTHER account (`cloud_user` set to someone else) holds that account's data: nothing is uploaded, the new account's settings and key win, and synced keys the new account lacks are deleted (the key too; the Schwab worker URL stays), dropping the old account's unsent edits with a toast.
  Uploads go first, so a failure leaves the device as it was and retries; the old passphrase sync's keys (sync_id, sync_key, sync_dirty, last_sync_t, sync_url) are deleted then.
  A 401 or ended session keeps data and pending edits and asks to sign in again; edits keep counting as pending while `cloud_user` is set, even with the session gone, and go out after signing in again.
  Pushes keep keys pending (on the device too) until the server confirms them, so a page killed mid-save resends; a key edited mid-flight stays pending.
  A Tradier key typed while a pull asks Vault wins over Vault's answer.
  One push, pull or merge runs at a time (`state.cloudBusy` holds its promise).
  Sign out waits (up to 10s) for a running sync, then sends pending edits (cloudFlush; offline: the first press warns, a second discards), signs out locally only (`scope: 'local'`, other devices stay signed in), disconnects Schwab, clears every synced key (except the worker URL kept for the next login) and the cloud bookkeeping from the device, and reloads.
  Broker tokens carry their Google owner, worker URL, and connection id; unbound legacy tokens require a new login.
  Auth changes in other tabs disconnect the old broker session before reloading when someone else signs in; a session that ended with no one new (SIGNED_OUT from a failed refresh) reloads but keeps the Schwab login, bound to that user; a session this tab couldn't load at boot (offline: currentSession throws while one is still stored, 'Offline, will retry') coming back as the same user (cloud_user) just resumes, keeping the Schwab login.
  The Schwab login itself is shared by your devices through Vault too (`schwab_login:<uid>`, `schwab_login_at` stamps it): docs/schwab.md, One login for every device.
  Free plan: no automatic backups, pauses after a week of low activity.
  There is no export/import file (removed by request).
  The old encrypted Cloudflare sync worker is gone from the repo Saved position cards are retired (Positions shows live Schwab positions), so leftover `saved_positions` / `deleted_positions` keys on older devices are never sent; the `saved_positions` table from the first migration is dropped by the second
A Claude access key (Settings, docs/claude-access.md) is separate from sync: it reads the journal and saves reviews, never settings or the Tradier key.
