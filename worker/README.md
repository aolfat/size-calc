# size-calc sync worker

Tiny Cloudflare Worker + KV that stores one encrypted blob per sync id. The app
encrypts everything with your passphrase before uploading, so this worker (and
Cloudflare) only ever see ciphertext. Free tier is far more than enough.

## One-time setup (~15 min)

Needs a free Cloudflare account (no card, no domain) and Node installed.

```sh
cd worker
npx wrangler login                        # opens the browser to authorize
npx wrangler kv namespace create SYNC     # prints an id
# paste that id into wrangler.toml (replace PASTE_KV_NAMESPACE_ID_HERE)
npx wrangler deploy                       # prints your URL, e.g. https://size-calc-sync.you.workers.dev
```

Then in the app: Tradier API card → Sync → paste the URL, pick a passphrase
(8+ chars, it is the only lock on your data), Enable sync. Repeat the URL +
same passphrase on each device.

## Notes

- Wrong passphrase = different id = empty mailbox. There is no reset; pick a
  new passphrase on every device to start fresh.
- Blobs untouched for ~13 months expire automatically (TTL refreshes on write).
- `GET /<id>?meta=1` returns just the timestamp — the app polls with this.
