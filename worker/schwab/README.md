# size-calc Schwab worker

A small Cloudflare Worker that lets the app place Schwab orders. The browser
can't call `api.schwabapi.com` directly, and the token exchange needs your app
secret, which should not live in a web page. This worker:

- `GET /login?state=…` redirects to Schwab's login with your app key and callback URL
- `POST /token` swaps the code from the callback for tokens (uses the secret)
- `POST /refresh` swaps a refresh token for a fresh access token (uses the secret)
- `/trader/v1/*` relays Trader API calls with the app's bearer token

It stores nothing. Tokens go back to the app, which keeps them in that
browser's storage only (never in backups or sync). Browser calls are accepted
only from `ALLOWED_ORIGINS`.

## One-time setup

Needs your Schwab developer app (status "Ready For Use") and a free Cloudflare
account.

1. In the Schwab developer portal, note your app's **App Key**, **Secret**, and
   **Callback URL**.
2. Put that callback URL in `wrangler.toml` as `SCHWAB_CALLBACK_URL`. It must
   match the portal exactly, including any port or trailing slash.
3. Check `ALLOWED_ORIGINS` lists where you open the app (GitHub Pages, and
   `http://localhost:8765` for local testing).
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

- **Callback is `https://127.0.0.1` (the usual default):** the page fails to
  load. That's expected. Copy the whole address from the address bar and paste
  it into the app within about 30 seconds (the code expires fast).
- **Callback is the app's own URL** (for example
  `https://aolfat.github.io/size-calc/`): the app finishes the login by itself.
  Changing the callback in the portal can put the app back into review, so
  only do this if you're fine waiting.

Schwab ends every login after 7 days. The app says when it's time to log in
again.

## Notes

- Orders: a market entry (Day) that triggers a stop for the same shares once it
  fills (Schwab `TRIGGER` strategy). The stop lasts the day or until canceled,
  your pick in the review sheet.
- There is no Schwab sandbox for individual developers, so every order is real.
  Try one share first.
