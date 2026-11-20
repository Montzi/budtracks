# BudTracks bank-sync Worker

Cloudflare Worker that proxies the [Teller](https://teller.io/docs) API for BudTracks. It holds the Teller client certificate and each bank enrollment's access token (AES-GCM encrypted in Workers KV). The app talks only to this Worker, authenticated with a device key created by the one-time `POST /pair`.

## Endpoints
`GET /config` (public) · `POST /pair` (once) · `POST /enroll` · `GET /accounts` · `POST /accounts/:id/toggle {enabled}` · `GET /sync?since=YYYY-MM-DD` · `DELETE /enroll/:id`. All but the first two need `Authorization: Bearer <device key>`. `/sync` returns amounts as numbers with positive = money out.

## One-time setup
1. **Teller**: sign up at teller.io, create an application, note the **Application ID**, and download `certificate.pem` and `private_key.pem` (needed for development/production; not for sandbox).
2. **Cloudflare**: free account; create an API token with "Edit Cloudflare Workers" plus Workers KV edit and mTLS certificates edit permissions; note your Account ID.
3. **GitHub repo secrets** (Settings > Secrets and variables > Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELLER_CERT_PEM` (full contents of certificate.pem), `TELLER_KEY_PEM` (contents of private_key.pem), `TELLER_APP_ID`. Optional repo *variable* `TELLER_ENV` (`sandbox`, `development`, `production`; defaults to `development` when the cert is set, else `sandbox`).
4. Push to `main` (or run the "Deploy Worker" workflow). It tests, creates the KV namespace, uploads the cert, deploys, and generates `ENC_KEY` once. Never commit secrets or edit ids into `wrangler.toml` by hand for CI; placeholders are filled at deploy time.
5. In the app, pair once (the key is returned a single time and kept in the phone's localStorage). To re-pair, delete the `key_hash` key in the KV namespace.

## Local development
```
cd worker && npm install && npm test     # offline tests with mocked Teller
npx wrangler dev                          # needs real ids in wrangler.toml; localhost origins allowed in sandbox
```
Manual deploy: set the placeholders in `wrangler.toml`, upload the cert with `wrangler mtls-certificate upload --cert certificate.pem --key private_key.pem --name teller`, run `openssl rand -base64 32 | wrangler secret put ENC_KEY`, then `npm run deploy`. Do not rotate `ENC_KEY` afterwards: stored tokens would become unreadable (users must reconnect banks).
