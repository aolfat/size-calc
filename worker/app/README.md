# Dedicated app host

Deploy the static app to its own HTTPS origin without buying a domain:

```sh
npx wrangler deploy --config worker/app/wrangler.toml
```

Wrangler prints `https://size-calc-app.<your-account>.workers.dev`. Use that
address as the app's home. This worker serves static files only. Keep using
the existing Schwab API worker URL in Settings.

Before signing in:

1. Add the new app URL, including `?login=google`, to Supabase Auth's allowed
   redirect URLs. Set the Supabase Site URL to the new app root. Remove the
   old GitHub Pages redirect from the allowlist.
2. Set the Schwab developer app's callback to the new app root, with its
   trailing slash. Set the same `SCHWAB_CALLBACK_URL` in the existing Schwab
   worker's configuration. A callback change may require Schwab approval.
3. Replace `https://aolfat.github.io` in the Schwab worker's `ALLOWED_ORIGINS`
   with the new app's origin, without a trailing slash. Keep localhost only
   in development configuration, then redeploy the Schwab worker.
4. Open the dedicated app URL, sign in with Google, enter the existing API
   worker URL, and reconnect Schwab. Old unbound brokerage logins require a
   fresh login after this security update.

The GitHub Pages URL supports manual calculations only. It clears saved API
keys, Google sessions, and brokerage credentials on load and disables new
credential entry. Browser storage belongs to the entire host, so repository
paths under one `github.io` account cannot isolate credentials.

`.assetsignore` publishes only runtime files. `_headers` supplies the app's
security headers. No build step or application dependencies are needed.

## Operator access

The dedicated app host isolates browser storage from other sites. It does
not hide tokens from the existing Schwab worker operator: that worker must
receive usable tokens to call Schwab. Synced Tradier keys remain decryptable
by the Supabase project administrator. Settings discloses both boundaries.
