# Changelog

Versions match `VERSION` in `sw.js`. Newest first.

## 2026-11-26
- **v60** Side column: the tabs and Settings form one tight group at 48 px, the + matches that size and stands apart above. Settings lights up when you tap it, and hands the light back when you tap a tab.
- **v59** Side column +: smaller, outlined in the same color as the other icons, and lower so it clears the status area. Bud's bubble is smaller, sits lower beside the head, and keeps a clear gap under the Saved pill.
- **v58** Side column: a + button at the top for new spending, set apart from the tabs, which sit lower. Bud's thought bubble is a little smaller and drops below the Saved pill instead of covering it. Tests: six files loaded the page twice in a row, which cut the first bank sync off; they load it once now.
- **v57** Side column: Settings added as the last icon, icons sit near the bottom edge and are bigger. The Transactions header wraps to two rows when the column leaves it very narrow.
- **v56** iPhone Duo outer display: tabs move to the side column under the status bar, icons only, with badges. Found from the reserved column in portrait; landscape and other iPhones keep the bottom bar. Income, Appearance, Tabs: Auto, Side or Bottom for this phone.

## 2026-11-25
- **v55** Matching your own entry to a bill keeps it in Transactions with a Paid tag; totals count the payment once through the bill. Unmatch in its edit form. When the bank line arrives it links to the entry, for + entries too, not only screenshots.
- **v54** Match to a bill puts bills with the same amount first, paid or not. Tests block outside requests, so logo services no longer stall GitHub runs.
- **v53** Match to a bill also lists bills you already marked paid and ones up to two months back. Matching a paid bill merges it with your entry, so the payment counts once.
- **v52** Phones show one Cycle button that switches to Month; landscape keeps the two-part switch. Entries added with + list under Added by you, next to screenshot entries, with their logo or a colored icon. Edit one and tap Match to a bill to mark that bill paid with it. Test page loads may take 20 s on GitHub.
- **v51** New Home Screen icon: the Bt monogram polished, coral serif on a deep navy gradient with a glowing gold underline. Icon URLs carry `?v=51` so Safari fetches the new files. Remove and re-add the app to see it; back up first.
- **v50** Pull down from the top of Transactions to refresh. Cycle/Month switch matches the icon buttons. "Spent this cycle" fits on one line. Overview: Due today and Next cycle needs share one line. Ask Bud on the Income tab opens and closes.
- **v49** Your data text uses the full card width. No "from your bank" under the paycheck. Current balance lists banks in In account order, with logos and arrows to reorder both. Add to savings has a +. Transactions: Spent this pay cycle replaces the title, Cycle/Month sits before the camera, Updated time moved into the Spent list. Overview: Bills due today with a red count, above Next pay cycle needs.

## 2026-11-24
- **v48** Bank connections show each account's balance. Sync and Disconnect sit in the same spot on every bank; long bank names use a smaller font. Current balance sits beside Latest paycheck, each half opens on its own. Transaction icons without a logo get a solid color that matches the Overview chart.
- **v47** Settings and AI key links from Ask Bud land on the right card even on a slow phone. Tests: shared setup in `tests/lib.mjs`, one parallel runner `tests/run.mjs` with a fast lane, full suite on GitHub after each push, `scripts/deploy-status.sh`.
- **v46** Income tab: the pay cycle note is gone. Bank connections sits right under Add income and opens and closes like the other sections. Refresh all stays in its header.
- **v45** Transactions: Rename on every bank line, whatever its status. Your name wins over the bank's and over a match. It survives syncs and reloads. Use bank name puts it back.
- **v44** Messages: bank news (matched, to review, updated, sync errors) stays until closed with ✕. Every other message shows at least 10 seconds. Undo messages 10 s. Bud's speech bubbles 10 s, still hide on scroll. Only ✕ and Undo take taps.
- **v43** Landscape fixes: Overview chart level with the logo bar, Income tab in two balanced columns, full-width centered logo bar on other tabs. Planned by Opus, built by Sonnet workers.
- **v42** Ask Bud opens at the top of the screen at full height. The keyboard only moves its bottom edge.
- **v41** Chat header: New chat first (fresh start under a divider), Style, AI, Clear (two taps), settings icon last.
- **v40** Bud answers any question, not only money. He knows which model he runs on. AI button in the chat shows the model, tokens and cost per answer and switches models.
- **v39** Gemini falls back to 3.6 Flash and 3.5 Flash-Lite when 3.8 Flash is overloaded. Key test shows Google's message. Key field no longer triggers iOS password saving.
- Pages workflow split into build and deploy jobs. Fixes the artifact race.
- **v38** Paste an AI key in the app, stored encrypted on the Worker. Test key. Shows length and last 4 characters.
- Worker fix: iPhone long dash in pasted keys becomes `--` again.
- **v37** Chat keeps clear of the iPhone's side areas. Gemini errors show Google's codes and say plainly when the key is invalid.
- **v36** Ask Bud on Claude Haiku 5.5 by default, Gemini 3.8 Flash selectable in Settings.

## 2026-11-23
- **v35** Ask Bud: tap Bud for a chat under the logo. Hat options moved under Style. Settings button jumps to the Income tab settings. First version ran on Claude Opus 5.5; switched to Haiku in v36 for cost.
- Backup file for a new phone: data, uploaded and picked logos, optional bank pairing key. Restore from file or text.
- Logo field in the spending form: pick any logo or upload one per merchant.
- **v34** Late transactions match past bills, To review on top, PayPal double-count guard, screenshot entries without waiting, centered Plans switch, collapsible logos.
- **v33** Plans: cycle total on top, + icon, CSV import moved to Income, postpone a payment with recalculated schedule.
- **v32** Header fixed on every tab with the period button, Bud names the tab, new-data badges.
- **v31** One persistent Bud header on every tab. Saved pill in a fixed corner.
- **v30** Big due dates on plans, brand logos for services and merchants.
- **v29** Clearer plan cards, centered logo, logo in emails, service logos with uploads.
- **v28** Clear Resend errors, receipt photos, Transactions header with camera, add and sync icons, one-tap paste.
- **v27** Sync chip, spent summary with Cycle/Month on Transactions, theme in the hat sheet.

## 2026-11-22
- **v26** Add transactions from screenshots with Claude Haiku 5.5. They auto-match to bank rows later.
- **v25** Plaid webhooks for instant updates. One serialized sync object per bank (Durable Object).
- **v24** Bills & Finance split, sub-categories, Plaid status and honest refresh, late transactions match past bills.

## 2026-11-21
- **v23** Light cycle card, eye button to hide sums, savings accounts.
- **v22** Hero sums alignment, greeting line, working Sync button, light mode.
- **v21** Pay later and credit cards in the chart, tappable Spent so far and Still due, income trend chart, recap snapshot.
- Hourly balance and deposit email alerts, 7am recap email.
- **v20** Insurance under Transportation, Subscriptions slice, monthly chart toggle.
- **v19** Savings toggle, skip a cycle, one-time vs permanent amounts, bank labels.
- **v18** Refresh and reorder balances, hide sums, Gas and Groceries as cycle budgets.
- **v17** Fix accepted rows showing Needs review, collapsible Income sections, per-bank refresh.
- **v16** Grouped categories, notes, Transactions as second tab.
- **v15** Match picker with warnings, Likely completed tags.
- **v14** Transactions tab, latest paycheck detail, Plans with credit cards.

## 2026-11-20
- **v13** Combine split paychecks, live bank balances.
- **v12** Fix review inbox with paycheck or bill matches.
- **v11** Bank sync automatic from Nov 19.
- **v10** Category tuning from sandbox data.
- **v5 to v9** Bank sync built: Teller first, then Plaid after Teller shut down. Two-phase sync cursor. Landscape layout and per-paycheck income.

## 2026-11-18
- First release: installable pay-cycle budget app on GitHub Pages.
