# How BudTracks updates are made

Working rules for anyone (or any Claude session) changing this repo. Keep this file current after every release.

## Status (2026-11-26)
- Live release: `budtracks-v59` on https://montzi.github.io/budtracks/
- Worker `budtracks-worker` live on Cloudflare, Plaid **production**.
- AI: Claude Haiku 5.5 default, Gemini 3.8 Flash optional. Both keys work.
- Nothing pending.

## The user's preferences
- Short sentences, no filler, no em dashes, no parenthetical clauses in user-facing text.
- Read files before editing. Prefer small edits over rewrites.
- Test before saying something is done.
- Large jobs: plan with Opus, delegate pieces to Sonnet subagents, review their diffs, run every suite.
- Small jobs: fast lane only. The user tests on the phone and gives feedback.

## Release flow (every update)
Aim: a small change ships in 5 to 8 minutes. The user checks it on the phone and gives feedback.
1. Branch from `main` (`v47`, `v48`, ... or a feature name).
2. Read the relevant code in `index.html` or `worker/src/index.js` first.
3. Make the change. Keep logic in the `BT` module when it is pure, so node tests can load it.
4. Bump `VERSION` in `sw.js` (`budtracks-vNN`) for any app change. Phones only refresh when it changes.
5. Tests, only what the change needs:
   - Text or style only: no new test.
   - New behavior: a short `tests/vNN.e2e.mjs`. Copy `tests/v46.e2e.mjs`. Import setup from `tests/lib.mjs`.
   - Logic: `tests/*.test.mjs`. Worker: `worker/test/*.test.js`.
6. Fast lane, about 2 minutes: `node tests/run.mjs quick vNN <words>`. It runs the logic tests plus the e2e files whose names contain the words. Pick the files near the change. Run `cd worker && npm test` only when `worker/` changed.
7. Commit with a plain sentence describing what the user sees. Push the branch.
8. `git checkout main && git merge --ff-only <branch> && git push origin main`.
9. `scripts/deploy-status.sh`. It polls every 10 s and stops when Pages is done.
10. Tell the user: close and reopen the app once. Ask for feedback.
11. Update `CHANGELOG.md` and the Status above.
12. GitHub runs the full suite after each push: the `Tests` workflow, about 6 minutes. It does not block the deploy. At the start of the next session, check it with `scripts/deploy-status.sh`. If it is red, fix that first.

## Tests
- `node tests/run.mjs` runs everything in parallel and retries a failed file once. It starts its own local server.
- `tests/lib.mjs` holds shared setup: `prep(page)`, `step`, `finish`, `synced`, date helpers. A change that affects every test goes there, not in 20 files.
- Wait for a condition, never a fixed pause. Fixed pauses fail when tests run in parallel.

## Deploy details
- **App:** `pages.yml` runs on every push to `main`. Build and deploy are separate jobs; this fixed the "No artifacts named github-pages" race. Only `index.html`, `manifest.webmanifest`, `sw.js` and `icons/` are published.
- **Worker:** `worker.yml` runs on push to `main` touching `worker/**` or the workflow. It runs `npm test`, ensures KV, fills `wrangler.toml` placeholders, deploys, then sets secrets from GitHub.
- `workflow_dispatch` is refused from cloud sessions (403). To redeploy, push a small change: an empty commit for Pages, a comment change under `worker/` for the Worker.
- If Pages fails with a transient artifact error, push an empty "Redeploy Pages" commit.

## Secrets and keys
- Never paste keys in chat and never commit them. The repo is public.
- GitHub repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `PLAID_CLIENT_ID`, `PLAID_SECRET`, `RESEND_API_KEY`, `ALERT_EMAIL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. Repo variable `PLAID_ENV=production`.
- `ENC_KEY` is generated once by CI. Never rotate it: stored bank tokens and AI keys would become unreadable.
- AI keys can also be saved in the app (Settings, Ask Bud, Save). They are encrypted in KV and win over the GitHub secret. "Use the GitHub secret instead" deletes the app copy.
- iPhone pastes: Smart Punctuation turns `--` into a long dash. The Worker's `cleanKey` turns it back. The key field is a masked text field so iOS does not offer to save a password.
- Do not put the user's name or email in the repo.

## Privacy rules in code
- Budget data stays on the phone. The Worker stores only encrypted tokens, sync rows and the recap snapshot.
- Ask Bud gets a summary built on the phone by `aiContext()`. It never includes the bank key or logo images.
- Worker logs hold counts and error codes only. Never questions, answers, merchant names, data or keys.
- Text from data and chat history is treated as data, never as instructions to the model.

## Code map (index.html)
- `BT` module: pure logic (cycles, classification, matching, bank pipeline). `normalize` migrates stored state.
- State: localStorage `budtrack.v1`. Bank pairing key: `budtrack.bankkey`. Chat: `budtrack.chat`. AI spend: `budtrack.aispend`.
- Views: `viewOverview`, `viewIncome` (two columns in landscape), and the others. Actions go through one `data-action` switch.
- Messages: `toast(msg, undo, {sticky})`, `TOAST_MS = 10000`, `commit(msg, o)`. Bank news is sticky with an ✕.
- Logos: `state.logoFor` maps a merchant key to a logo. `addLogoField` adds the picker in the spending form.
- Backup: `saveBackupFile`, `readBackup`, `restoreAsk`, `restoreNow`. Envelope `{app, kind:'backup', v:2, at, data, bank?}`.
- Names: `state.bank.names` maps a bank line id to the name you typed. `cleanMerchant` returns it first. `setTxName` saves it.
- Income tab: Latest paycheck card has two halves, `pay` and `bal`. `balHalf()` builds Current balance from `bankTotal()`, like In account. `acctBalHTML` shows a balance on bank cards.
- Overview: `dueTodayHTML()` above the hero foot, `heroListSheet('today')` lists today's unpaid bills. Transactions header is `txSummaryHTML()` returning `{ btn, seg }`; tests read its Updated time with `txUpdated(page)` from `tests/lib.mjs`.
- Your own entries: `shotWaitHTML()` lists screenshot entries and ones added with + (`mine: true`), with `manualLogo`. `spMatchSheet` / `spMatch` match one to a bill: the bill is marked paid and the entry stays with `billKey`, `billName` and `billMarked`; `BT.occurrences` skips spends with `billKey` so the bill counts it once. `spUnmatch` reverses it. Bank lines link to `shot` and `mine` entries alike. The list covers 62 days back to 22 ahead: Same amount first, paid or not, then Not paid yet, then Already marked paid. Their actions sit in the main action switch, not `txAct`.
- Range control: `.tx-rg1` one button on phones, `.seg` in landscape. Tests click `[data-action="tx-range"][data-r="month"]:visible`.
- iPhone Duo side tabs: `railCheck()` reads `#railprobe`'s env(safe-area-inset-left/right). Portrait with 24 px or more reserved sets `html.rail`. The Tabs setting in Appearance is `budtrack.rail` in localStorage: auto, side or bottom, per phone. Tests fake the column by padding `#railprobe`. The column ends with `.tab-set`, a Settings button shown only there, action `go-settings`. Icons are bottom-aligned, 56 px. `.tab-add` is a 48 px outlined + near the top of the column at 28vh, action `add` type `extra`.
- Pull to refresh: `PTR` touch handlers near `SCROLLTO`. A pull of 70 px from the top of Transactions clicks the header sync button.
- Ask Bud card is collapsible with key `ai`. `goSettings('aicard')` opens it. `prep(page)` opens `bank` and `ai` for tests.
- Current balance list reorders banks with `bal-move`, the same `state.bank.order` as In account.
- Icons: `catColor(cat)` gives a category the color of its group in this cycle's chart. `CATCOL` resets on each render.
- Income tab: collapsible sections use `collHead` and `INCOPEN` in `budtrack.incopen`. Bank connections is key `bank`. `prep(page)` in `tests/lib.mjs` opens it for tests.
- Ask Bud: `#budchat`, `budAsk`, `aiContext`, `chatPlace`, `bcMenuHTML`, `aiCost`, `aiCard`, `aiKeyBox`, `goSettings`.

## Lessons learned
- Action names must be unique across the file (`lg-*` clashed with the chart legend, now `lgf-*`).
- CSS class names too (`.bud` clashed with the speech bubble, chat uses `.bot`).
- Toasts must not block taps: the pill has `pointer-events: none`; only its buttons take taps.
- Tests should close messages with ✕ instead of waiting for them to disappear.
- Load a test page once. `goto` then an immediate `reload` cut the first bank sync off after it saved its time but before the balances, and the next load saw a fresh sync and never asked again. That was the old `v12` flake. Set the hash with `history.replaceState`, then reload.
- `budSay` places the bubble beside the head, 30% down, and at least 26 px below the `.sync` pill.
- GitHub's test machine needs Inter as its default font, like the sandbox. `tests/fonts-prefer-inter.conf` does that. Without it, text is wider and layout checks fail.
- iOS never refreshes a Home Screen icon. A new icon needs: new PNGs from `scripts/render-icons.mjs`, a new `?v=` in `index.html`, `manifest.webmanifest` and `sw.js`, then the user removes and re-adds the app after a backup. Removing it can delete its data.
- Tests run offline: `prep(page)` aborts every request outside localhost, `worker.test` and `cdn.plaid.com`. GitHub's open network let logo services stall page loads.
- Plaid Trial caps at 10 bank logins and removing one does not free a slot.
- Teller shut down its API; Plaid replaced it.
