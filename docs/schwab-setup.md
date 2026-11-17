# The Schwab setup guide

The guide for other people (their own Schwab developer app and worker, no Tradier key) is `setup.html` at the app's root, served with the app at https://shwing-trader.aolfat.workers.dev/setup.html.
It moved out of this file because the repo is private: other people can't read GitHub, so the guide and the worker's code come from the app's own address.
The setup notice and Settings' Set up your own Schwab login link to it.
It offers `worker/schwab/worker.js` as a download (`.assetsignore` publishes that one file), and has people paste it into Cloudflare's dashboard editor and set its four variables there, so they need no git, Node or wrangler.
Change `worker/schwab/worker.js` and the guide's steps together: anyone's old copy keeps running until they paste the new one.
The guide names the app's address in three places (the Schwab callback, `SCHWAB_CALLBACK_URL`, `ALLOWED_ORIGINS`): update them if the app moves.
It shares `styles/legal.css` with the privacy page.
