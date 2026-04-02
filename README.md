# Pinder

Pinder is a static, client-side paper swiping app for GitHub Pages.

## Controls

- ↓ swipe: reject
- ← swipe: weak reject
- → swipe: weak accept
- ↑ swipe: accept
- Or tap the on-screen buttons
- Use the settings button in the top-right to hide/show the on-screen buttons

Each paper card shows:

- title
- authors
- abstract

Reviews are saved in `localStorage` on the device, so it works without a backend.

## Files

- `index.html` — app shell
- `styles.css` — mobile-friendly styling for iPhone and desktop
- `app.js` — swipe logic, local saving, Google Sheets sync, export, undo
- `google-api-config.js` — Google OAuth client config for Sheets sync
- `scrape-arxiv.js` — scraper for arXiv list pages
- `papers.json` — scraped paper data loaded by the app

## Scrape papers

By default the scraper pulls from:

`https://arxiv.org/list/cs.SE/2026-03?skip=0&show=2000`

Run:

```bash
node scrape-arxiv.js
```

Optional flags:

```bash
node scrape-arxiv.js --url "https://arxiv.org/list/cs.SE/2026-03?skip=0&show=2000" --output papers.json
node scrape-arxiv.js --limit 25 --concurrency 4
```

## Google login + Google Sheets sync

Pinder can optionally use Google login and the user's own Google Sheet to sync settings across devices while still being a static GitHub Pages app.

The app creates or reuses a spreadsheet named `Pinder Sync` in the signed-in user's Google Drive and stores settings there.

1. Open Google Cloud Console
2. Create or choose a project
3. Enable these APIs:
   - Google Sheets API
   - Google Drive API
4. Configure the OAuth consent screen
5. Create an OAuth 2.0 Client ID for a web application
6. Add authorized JavaScript origins, including:
   - `http://localhost:3000`
   - your GitHub Pages origin, e.g. `https://yourname.github.io`
7. Edit `google-api-config.js` and fill in `clientId`

Without Google OAuth config, the app still works locally with device-only settings.

## Test locally

Because the app fetches `papers.json`, run it through a local static server instead of opening `index.html` directly.

```bash
npx serve . -l 3000
```

Then open:

`http://localhost:3000`

## Deploy

Push this repo to GitHub and enable GitHub Pages for the repository.

The app is fully client-side and loads `papers.json` from the same static site.
