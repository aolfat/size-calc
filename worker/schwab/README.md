# size-calc Schwab worker

A small Cloudflare Worker that lets the app place Schwab orders and read Schwab quotes. The browser
can't call `api.schwabapi.com` directly, and the token exchange needs your app
secret, which should not live in a web page. This worker:

- `GET /login?state=…` redirects to Schwab's login with your app key and callback URL
- `GET /callback` tells the app the callback URL, so it can drop the paste box when the callback is the app itself
- `POST /token` swaps the code from the callback for tokens (uses the secret)
- `POST /refresh` swaps a refresh token for a fresh access token (uses the secret)
- `/trader/v1/*` relays Trader API calls with the app's bearer token
- `GET /marketdata/v1/*` relays market data reads the same way (a futures ticker's quotes and bars)

It stores nothing. Tokens go back to the app, which keeps them in that
browser's storage only (never in sync). Browser calls are accepted
only from `ALLOWED_ORIGINS`. The worker operator can access tokens passing
through this worker. They are not hidden from the operator by encryption.

## One-time setup

Needs your Schwab developer app (status "Ready For Use") and a free Cloudflare
account.

1. In the Schwab developer portal, note your app's **App Key**, **Secret**, and
   **Callback URL**.
2. Put that callback URL in `wrangler.toml` as `SCHWAB_CALLBACK_URL`. It must
   match the portal exactly, including any port or trailing slash.
3. Set `ALLOWED_ORIGINS` to the app's dedicated HTTPS origin. See
   [the dedicated app host](../app/README.md) for a free `workers.dev` address.
   Use `http://localhost:8765` only for local testing. GitHub Pages repository
   paths cannot isolate credentials and credential entry is disabled there.
4. Deploy:

```sh
cd worker/schwab
npx wrangler login
npx wrangler deploy                         # prints https://size-calc-schwab.<you>.workers.dev
npx wrangler secret put SCHWAB_APP_KEY      # paste the App Key
npx wrangler secret put SCHWAB_APP_SECRET   # paste the Secret
```

Until both secrets are set, the worker answers "worker not configured".

Then in the app: Settings → Schwab trading → paste the worker URL → Log in to
Schwab.

## Logging in

After the Schwab login, Schwab sends the browser to your callback URL with a
`code` in the address.

- **Callback is the app's own URL** (recommended, for example
  `https://size-calc-app.<your-account>.workers.dev/`): the app finishes the login by itself.
  The worker reports its callback at `/callback`, and when it's the app's own
  page, Settings hides the paste box. The portal takes one HTTPS address (a
  comma list was rejected). Changing the callback can put the app back into
  review, so do it right after a fresh login.
- **Callback is `https://127.0.0.1`:** the page fails to load. That's
  expected. Copy the whole address from the address bar and paste it into the
  app within about 30 seconds (the code expires fast).

Schwab ends every login after 7 days. The app says when it's time to log in
again.

## Notes

- Orders: a market entry (Day) that triggers a stop for the same shares once it
  fills (Schwab `TRIGGER` strategy). The stop lasts the day or until canceled,
  your pick in the review sheet.
- There is no Schwab sandbox for individual developers, so every order is real.
  Try one share first.
- Futures tickers (/MES) read `/marketdata/v1/quotes` and `/pricehistory`.
  They need this worker redeployed (`npx wrangler deploy`) after the market
  data relay was added, and your Schwab app subscribed to **Market Data
  Production** in the developer portal. Until then loading one says what's
  missing.

## Security

- Signing out of Google also disconnects Schwab on that device. Each broker
  connection is bound to the Google user (or a signed-out session), the worker
  URL, and a unique connection id. A different Google user must reconnect.
  Old tokens without these bindings require a fresh Schwab login.
- History imports stop when the Google user, broker account, or connection
  changes. Delayed login, refresh, and account responses cannot restore a
  disconnected connection. Token and Trader API responses use `no-store`.
- An origin is the whole host, not a repo: `https://aolfat.github.io` is every
  GitHub Pages site under that account. Any of them shares the app's
  localStorage (the Schwab tokens included) and passes `ALLOWED_ORIGINS`, so it
  can call the worker as the app.
- `/token` and `/refresh` check only the Origin header, which anything outside a
  browser can set. A stolen refresh token gets fresh access tokens until Schwab
  ends the login, up to 7 days.
- Serve the app from its own origin, list only that in `ALLOWED_ORIGINS`, and
  keep other pages off it. The app runs on `aolfat.github.io`, which is safe
  only while no other Pages site is published under that account. Before
  adding one, or inviting users to connect brokerage accounts, move the app to
  its own host (`../app/README.md`): deploying code does not update Schwab or
  Supabase callback settings.
- Supabase Vault encrypts synced Tradier keys at rest, but the database
  administrator can decrypt them. Settings discloses this separately from the
  Schwab worker's token access. Neither storage path is operator-blind.
