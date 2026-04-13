# Pinder

Pinder is a static, client-side paper swiping app for GitHub Pages.

## Controls

- ↓ swipe: reject
- ← swipe: weak reject
- → swipe: weak accept
- ↑ swipe: accept
- Or tap the on-screen buttons
- Use the sign-in/sign-out button in the top-right to connect Google Sheets sync
- Use the settings button in the top-right to hide/show the on-screen buttons and authors

Each paper card shows:

- title
- authors
- abstract

Reviews are saved in `localStorage` on the device, so it works without a backend.

## Files

- `index.html` — app shell
- `styles.css` — mobile-friendly styling for iPhone and desktop
- `app.js` — swipe logic, local saving, export, undo
- `auth.js` — Google Sheets auth and sync logic
- `google-api-config.js` — Google OAuth client config for Sheets sync
- `scrape.js` — client-side paper source fetcher/parser used by the app, plus the reusable Researchr track scraper used for ICSE datasets
- `data/icse.json` — hardcoded ICSE 2018–2026 track URLs together with the scraped paper data
- `scripts/scrape-icse-tracks.js` — Playwright-based collector that opens each ICSE track page and refreshes `data/icse.json`
- `package.json` — development dependency for the ICSE scraping script

## Paper source

By default the app fetches papers from the current browser year-month in `cs.SE`, for example:

`https://arxiv.org/list/cs.SE/YYYY-MM?skip=0&show=2000`

It fetches papers dynamically in the browser through `scrape.js`, shows the newest papers first for the selected month, and then keeps loading older months so the feed continues backward in time.

You can override the source with a query parameter.

arXiv monthly list example:

```txt
?source=https://arxiv.org/list/cs.SE/2026-04?skip=0&show=2000
```

Static JSON example:

```txt
?source=data/icse.json&track=2026
```

If the source URL is an arXiv monthly list URL, Pinder keeps going backward month by month from that starting point.

If the source URL points to a JSON file, Pinder loads it as-is. The JSON source can be either:

- an array of paper objects,
- an object with `papers`, plus optional `sourceLabel` and `sourceUrl`, or
- an object with `tracks`, where you select a track via `?track=...`

Each paper can include fields such as:

- `id`
- `title`
- `authors`
- `authorsText`
- `abstract`
- `absUrl`
- `pdfUrl`
- `loaded`

Because arXiv does not expose browser-friendly CORS headers for this workflow, `scrape.js` uses a public CORS proxy to read arXiv pages client-side when needed. Local JSON files on the same origin are loaded directly.

Bundled custom feed:

- `data/icse.json`

It contains the hardcoded ICSE 2018–2026 track metadata together with all collected accepted-paper abstracts.

Examples:

```txt
?source=data/icse.json&track=2026
?source=data/icse.json&track=icse-2024-research-track
```

If `track` is omitted, Pinder uses the collection's `defaultTrack`.

Tap the source label in the header to switch between the default arXiv feed and the ICSE collection.

When an ICSE collection is loaded, the UI also shows an `ICSE year` dropdown in the header so you can switch years without editing the URL manually.

## Regenerating the ICSE datasets

The hardcoded ICSE track URLs and scraped outputs live together in:

- `data/icse.json`

The collector navigates to each conference page with Playwright and runs the reusable Researchr scraping function from `scrape.js` inside that page, then writes the updated results back into `data/icse.json`.

To re-scrape them:

```bash
npm install
npx playwright install chromium
npm run scrape:icse
```

You can also scrape just one year or slug:

```bash
node scripts/scrape-icse-tracks.js 2026
node scripts/scrape-icse-tracks.js icse-2024-research-track
```

## Google login + Google Sheets sync

Pinder can optionally use Google login and the user's own Google Sheet to sync settings and review outcomes across devices while still being a static GitHub Pages app.

The app creates or reuses a spreadsheet named `Pinder Sync` in the signed-in user's Google Drive and stores:

- settings in the `settings` tab
- review outcomes in the `decisions` tab

Review outcomes are stored with each paper's URL and paper ID. For arXiv feeds, this uses the paper's arXiv abstract URL.

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

Google auth is cached in the current browser tab/session, so refreshing the page should not require signing in again until the session expires.

## Test locally

Because the app fetches scripts and paper data dynamically, run it through a local static server instead of opening `index.html` directly.

```bash
npx serve . -l 3000
```

Then open:

`http://localhost:3000`

## Deploy

Push this repo to GitHub and enable GitHub Pages for the repository.

The app is fully client-side and fetches arXiv or JSON paper data dynamically in the browser.
