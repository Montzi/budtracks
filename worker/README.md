# BudTracks bank-sync Worker

Cloudflare Worker that proxies the [Plaid](https://plaid.com/docs/) API for BudTracks (it replaced Teller, which shut down its API). It holds the Plaid keys and each bank Item's access token (AES-GCM encrypted in Workers KV, with the `/transactions/sync` cursor). The app talks only to this Worker, authenticated with a device key created by the one-time `POST /pair`.

## Endpoints
`GET /config` (public, `{provider, env, paired}`) · `POST /pair` (once) · `GET /link-token[?item=<id>]` (update mode for reconnect) · `POST /enroll {publicToken, institution}` · `GET /accounts` · `POST /accounts/:id/toggle {enabled}` · `GET /sync?since=YYYY-MM-DD[&full=1][&ack=<token>][&item=<id>]` (`item` syncs one bank only; an `ack` still commits every bank that holds it) · `POST /refresh[?item=<id>]` · `DELETE /enroll/:id`. `DELETE /pair` (authenticated; clears the stored key hash so a new device can pair) · `POST /sandbox/item {institution_id?, dynamic?}` (sandbox only, else 404; creates a test Item via `/sandbox/public_token/create` and enrolls it like `/enroll`, institution "Sandbox bank"). All but `/config` and `POST /pair` need `Authorization: Bearer <device key>`. `/sync` returns `{txns, removed, errors, syncedAt}` with amounts as numbers, positive = money out; `removed` holds `pl:` ids Plaid deleted (for example a pending charge replaced by its posted version). `full=1` re-fetches history from an empty cursor; the stored cursor only changes when the whole run succeeds.

## One-time setup
1. **Plaid**: sign up at dashboard.plaid.com. A Team created after Apr 15 2026 is on the **Trial** plan: real production data, **at most 10 Items (bank logins)**, plus a free sandbox. On the Keys page note the `client_id`, the **sandbox** secret and the **production** secret.
2. **Redirect URI** (needed for OAuth banks such as Chase, Capital One, PNC on a phone): Developers > API > Allowed redirect URIs, add `https://montzi.github.io/budtracks/`.
3. **Cloudflare**: free account; create an API token with "Edit Cloudflare Workers" plus Workers KV edit permissions; note your Account ID.
4. **GitHub repo secrets** (Settings > Secrets and variables > Actions): `PLAID_CLIENT_ID`, `PLAID_SECRET` (the secret for the environment you deploy: sandbox first), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Optional repo *variable* `PLAID_ENV` (`sandbox` by default; set `production` to go live and swap `PLAID_SECRET` to the production secret).
5. Push to `main` (or run the "Deploy Worker" workflow). It tests, creates the KV namespace, deploys, sets the Plaid secrets on the Worker each deploy and generates `ENC_KEY` once. Never commit secrets or edit ids into `wrangler.toml` by hand for CI; placeholders are filled at deploy time. When going live, `PLAID_REDIRECT_URI` is set to `https://montzi.github.io/budtracks/`.
6. In the app, pair once (the key is returned a single time and kept in the phone's localStorage). To re-pair, delete the `key_hash` key in the KV namespace.

Sandbox login for testing: pick any bank in Link, user `user_good`, password `pass_good`.

## Testing
`cd worker && npm test` runs offline tests against a mocked Plaid. In a sandbox deploy, `POST /sandbox/item` (Bearer key) adds a test bank without Link; pass `{"dynamic": true}` to use Plaid's `user_transactions_dynamic` test login. `DELETE /pair` with the current key unpairs so another device can pair (no manual KV edit needed).

## Limits worth knowing
- Trial caps at 10 bank logins. **Removing an Item does not free a slot**, so avoid connect/disconnect churn.
- Re-enabling an account that was toggled off does not backfill what was skipped while it was off; run a full re-sync (`/sync?full=1`) to pull it back.
- Plaid returns about 90 days of history on first sync (`days_requested: 90`).

## Local development
```
cd worker && npm install && npm test     # offline tests with mocked Plaid
npx wrangler dev                          # needs real ids in wrangler.toml and Plaid secrets; localhost origins allowed in sandbox
```
Manual deploy: set the placeholder in `wrangler.toml`, run `wrangler secret put PLAID_CLIENT_ID`, `wrangler secret put PLAID_SECRET`, `openssl rand -base64 32 | wrangler secret put ENC_KEY`, then `npm run deploy`. Do not rotate `ENC_KEY` afterwards: stored tokens would become unreadable (users must reconnect banks).

