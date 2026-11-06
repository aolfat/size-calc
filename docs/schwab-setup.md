# Use the app with your own Schwab login

For anyone using https://aolfat.github.io/size-calc/ without a Tradier key.
You make your own Schwab developer app and run your own copy of the small worker that logs you in.
After that, quotes, charts, option chains, futures, positions and orders all come from your Schwab account.
It takes about 20 minutes of work, plus Schwab's wait to approve your app.

Why your own: Schwab's individual developer access covers your own accounts, so each person brings their own app.
The worker runs on your Cloudflare account, so your Schwab tokens pass only through your worker and your browser.

## What you need

- A Schwab brokerage account.
- A free Cloudflare account (https://dash.cloudflare.com/sign-up).
- A computer with Node.js 18 or newer and git (for one deploy command).

## 1. Make a Schwab developer app

1. Sign up at https://developer.schwab.com and ask for individual developer access (Trader API, Individual).
2. Create an app with two API products: **Accounts and Trading Production** and **Market Data Production**.
3. Set its callback URL to exactly `https://aolfat.github.io/size-calc/` (with the trailing slash).
   Settings in the app shows this address under Schwab, Set up your own Schwab login.
4. Wait until the app's status says **Ready For Use**. "Approved - Pending" isn't ready yet; this can take a few days.
5. Note the app's **App Key** and **Secret**.

Without Market Data Production, logging in works but quotes and charts don't: the app says Schwab refused the market data.

## 2. Deploy your worker

```sh
git clone https://github.com/aolfat/size-calc.git
cd size-calc/worker/schwab
npx wrangler login                          # opens Cloudflare in your browser
npx wrangler deploy                         # prints https://size-calc-schwab.<you>.workers.dev
npx wrangler secret put SCHWAB_APP_KEY      # paste the App Key
npx wrangler secret put SCHWAB_APP_SECRET   # paste the Secret
```

Leave `wrangler.toml` as it is: its callback and allowed origins are the hosted app's.
Until both secrets are set, the worker answers "worker not configured".
The worker stores nothing.

## 3. Connect in the app

1. Open https://aolfat.github.io/size-calc/ and tap the settings button.
2. Leave the Tradier API key empty.
3. Under Schwab, paste your worker URL and tap **Log in to Schwab**.
4. Log in at Schwab; it sends you back to the app, which finishes by itself.
5. Pick your account. The status line at the top of Settings says Quotes from Schwab.

Add the app to your iPhone home screen from Safari's share menu if you like.

## Good to know

- Schwab ends every login after 7 days; the app's banner says when to log in again.
- Every order is real: Schwab has no sandbox. Try one share first.
- Without a Tradier key the price doesn't stream: Live checks the quote every 2 seconds.
- An option contract's own price history isn't on Schwab, so the journal's option bars and the option pane of a position chart stay empty; the underlying's charts work.
- Signing in with Google is optional. It syncs your settings and shares your Schwab login with your other devices, kept encrypted in the app's database, which the app's administrator can decrypt. Signed out, everything stays in your browser.
- You can turn the worker off any time in Cloudflare, or delete the app in Schwab's developer portal.

## If something doesn't work

- **"Your Schwab worker can't read market data yet":** your worker is older than the market data relay; run `npx wrangler deploy` again.
- **"Schwab refused the market data":** add Market Data Production to your Schwab app, wait for Ready For Use, then log in again.
- **Schwab says the callback doesn't match:** the app's callback URL in the developer portal must be exactly `https://aolfat.github.io/size-calc/`.
- **"worker not configured":** set both secrets (step 2).
