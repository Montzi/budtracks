# BudTracks

Pay-cycle budget tracker for one person. Installable web app (PWA) on GitHub Pages, with a Cloudflare Worker for bank sync, email alerts and AI.

- App: https://montzi.github.io/budtracks/
- Worker: https://budtracks-worker.atsdsc27.workers.dev
- Current release: `budtracks-v65` (see `sw.js`)
- History: [CHANGELOG.md](CHANGELOG.md). How updates are made: [CLAUDE.md](CLAUDE.md). Worker details: [worker/README.md](worker/README.md).

## What is in the repo
| Path | What it is |
|---|---|
| `index.html` | The whole app: HTML, CSS and one script. A pure `BT` module holds the budget logic; the rest is UI. |
| `sw.js` | Service worker for offline use. `VERSION` is bumped on every release so phones pick up the new build. |
| `manifest.webmanifest`, `icons/` | Install metadata and icons (also `icons/email-logo.png` for alert emails). |
| `worker/` | Cloudflare Worker `budtracks-worker`: Plaid, Resend email, `/scan` and Ask Bud. Own README and tests. |
| `tests/` | Node unit tests (`*.test.mjs`) and Playwright end-to-end scripts (`*.e2e.mjs`). |
| `scripts/render-email-logo.mjs` | Renders the email logo PNG. |
| `.github/workflows/pages.yml` | Deploys the app to Pages on push to `main` (build job, then deploy job). |
| `.github/workflows/worker.yml` | Tests and deploys the Worker on push to `main` that touches `worker/**`. |

## Features (current)
- **Tabs:** Overview, Transactions, Bills, Plans, Income. Settings sit on the Income tab below the income section. Bank connections sits right under Add income and opens and closes. One fixed header with Bud on every tab; Bud names the tab and shows quick messages.
- **Pay cycles:** income per paycheck, bills, budgets per cycle or month, savings, "Left in paycheck" and "Still due".
- **Charts:** spending by parent category, monthly toggle, income trend. Landscape has its own layout.
- **Transactions:** categories with sub-categories, notes, receipt photos, To review on top. Rename any row, matched or not, and your name always wins. Edit a row to change its **Logo**: pick any logo or upload one; it applies to that merchant everywhere.
- **Plans:** Klarna, Afterpay, PayPal pay plans and credit cards, due dates, postpone a payment.
- **Bank sync (Plaid production):** automatic on open and with Sync, instant updates by webhook, review inbox, matching to bills, plans and paychecks, undo.
- **Add from screenshot:** Claude Haiku 5.5 reads banking app screenshots; real bank rows later link to them.
- **Email (Resend):** low balance, overdrawn, deposits, reconnect, 7am New York recap.
- **Ask Bud:** tap Bud's head to chat. He sees a summary of your budget built on the phone and answers anything. Header: New chat, Style, AI, Clear, settings icon, close. AI menu shows the model, tokens and cost per answer and lets you switch.
- **AI choice:** Claude Haiku 5.5 (default) or Gemini 3.8 Flash (free tier, falls back to 3.6 Flash and 3.5 Flash-Lite). Keys are saved from Settings, Ask Bud card, encrypted on the Worker.
- **Messages:** bank news (matched, to review, updated, sync errors) stays until you tap ✕. Every other message shows at least 10 seconds. Only ✕ and Undo take taps.
- **Style:** hat and theme options live under Style. Light and dark mode.

## Install on a phone
1. Open the app URL in Safari (iPhone) or Chrome (Android).
2. iPhone: Share, Add to Home Screen. Android: menu, Install app.
3. After a release, close and reopen the app once to load it.

## Your data and backups
- Budget data lives only on the phone, in localStorage (`budtrack.v1`). Nothing personal is stored in this repo.
- Other local keys: `budtrack.bankkey` (Worker pairing key), `budtrack.chat` (Ask Bud chat, not in backups), `budtrack.aispend` (Claude spend on this phone).
- **Backup for a new phone:** Income tab, Your data, Save backup file. The file holds all data, uploaded and picked logos, and optionally the bank pairing key (checkbox).
- **Restore:** Your data, Restore from file (or paste backup text). A summary shows before anything is replaced. Old plain-text backups still restore.

## Testing
```bash
node tests/run.mjs                    # everything, in parallel
node tests/run.mjs quick v46 bank     # logic tests + e2e files whose names contain v46 or bank
cd worker && npm install && npm test  # Worker
```
The runner starts a local server on port 8765. The e2e scripts mock the Worker at `https://worker.test`. Shared setup lives in `tests/lib.mjs`. GitHub runs the full suite after every push in the `Tests` workflow.
