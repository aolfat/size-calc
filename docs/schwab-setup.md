# Use the app with your own Schwab login

For a friend using the app without a Tradier key, and for the owner, who sets up their login.
Your friend uses the website like anyone else: nothing to install, clone or deploy.
Schwab's individual developer access covers your own accounts, so each person makes their own Schwab developer app (free); the owner runs a small login worker for it, since the app's Secret can't live in a web page.
After that, quotes, charts, option chains, futures, positions and orders all come from the friend's Schwab account.

## For your friend

### 1. Make a Schwab developer app (start now: approval can take a few days)

1. Sign up at https://developer.schwab.com and ask for individual developer access (Trader API, Individual).
2. Create an app with two API products: **Accounts and Trading Production** and **Market Data Production**.
3. Set its callback URL to exactly `https://127.0.0.1`
4. Wait until the app's status says **Ready For Use**. "Approved - Pending" isn't ready yet.

### 2. Send the owner the App Key and Secret

Use something private: a password manager's share, or a message that disappears.
Not email, and not a group chat.
The owner sets up your login worker and sends back its URL.

### 3. Connect in the app

1. Open the app and tap the settings button. Leave the Tradier API key empty.
2. Under Schwab, paste the worker URL and tap **Log in to Schwab**.
3. Log in at Schwab. You land on a page that doesn't load (https://127.0.0.1): that's expected.
4. Copy that page's whole address and paste it into Settings within about 30 seconds, then tap Connect.
5. Pick your account. The status line at the top of Settings says Quotes from Schwab.

Add the app to your iPhone home screen from Safari's share menu if you like.

### Good to know

- Schwab ends every login after 7 days; the app's banner says when to log in again (the same copy and paste).
- Every order is real: Schwab has no sandbox. Try one share first.
- Without a Tradier key the price doesn't stream: Live checks the quote every 2 seconds.
- An option contract's own price history isn't on Schwab, so the journal's option bars and the option pane of a position chart stay empty; the underlying's charts work.
- The owner runs your login worker, so the owner could see your Schwab tokens as they pass through, and holds your app's Secret. Only do this with someone you trust.
- Signing in with Google is optional. It syncs your settings and shares your Schwab login with your other devices, kept encrypted in the app's database, which the owner can decrypt. Signed out, everything stays in your browser.
- To end it: Disconnect in Settings, and delete the app in Schwab's developer portal.

## For the owner: set up a friend's login worker

Needs Node 18+ and this repo on your computer, once: `npx wrangler login` (your Cloudflare account, where your own Schwab worker runs).

```sh
node scripts/friend-worker.mjs <friend>             # asks for their App Key and Secret, hidden
```

It deploys `worker/schwab` again as `size-calc-schwab-<friend>`, with their callback (`https://127.0.0.1`) and the app's address from `worker/schwab/wrangler.toml`, sets their key and secret as the worker's secrets, and prints the worker URL to send them.
The secrets go straight to Cloudflare: never printed, never saved in the repo or on disk.
Your own worker is untouched.

- `--dry-run` checks the deploy without uploading anything or asking for secrets.
- `--redeploy` deploys again with the secrets kept: after a change to the worker, or after the app moves to a new address (update `ALLOWED_ORIGINS` in `worker/schwab/wrangler.toml` first, then redeploy each friend's).
- `--callback <url>` if their Schwab app uses a different callback, exactly as in their portal.
- To end a friend's access: delete their worker in Cloudflare (Workers & Pages).

Then delete the key and secret from wherever they sent them.

## If something doesn't work

- **"Your Schwab worker can't read market data yet":** the worker is older than the market data relay; the owner runs `--redeploy`.
- **"Schwab refused the market data":** add Market Data Production to the Schwab app, wait for Ready For Use, then log in again.
- **Schwab says the callback doesn't match:** the callback URL in the Schwab portal must be exactly `https://127.0.0.1`, the same as the worker's.
- **The pasted address is refused:** it took more than about 30 seconds, or it came from another login attempt; tap Log in to Schwab again.
- **"worker not configured":** the worker has no key or secret; the owner runs the script again without `--redeploy`.
