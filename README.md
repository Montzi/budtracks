# BudTracks

Pay-cycle budget tracker. Installable web app hosted on GitHub Pages.

## Install on your phone
1. Open the Pages URL in Safari (iPhone) or Chrome (Android).
2. iPhone: Share, then Add to Home Screen. Android: menu, then Install app.

## Move your data in
Data lives on the device only. Nothing is stored in this repo.
1. In the old BudTracks, open Settings, Your data, Copy backup.
2. In the installed app, open Settings, Your data, Restore from backup, and paste.

## Releasing
Push to `main`. The workflow in `.github/workflows/pages.yml` deploys.
Bump `VERSION` in `sw.js` so installed copies refresh.

## Roadmap
- Bank linking needs a small server to hold the aggregator's secret keys. Planned as phase 2.
