# Pinder

Pinder is a static, client-side paper swiping app for GitHub Pages.

## Controls

- ↓ swipe: reject
- ← swipe: weak reject
- → swipe: weak accept
- ↑ swipe: accept
- `U` or `⌘/Ctrl+Z`: undo the latest decision
- Or tap the on-screen buttons
- Inside the abstract modal, use the arrow keys to rate the open paper
- Use the sign-in/sign-out button in the top-right to connect Firebase sync
- Use the settings button in the top-right to hide/show the on-screen buttons and authors

Each paper card shows:

- title
- authors
- abstract

Reviews are saved in `localStorage` on the device, so it works without a backend.

To reduce repeat-load latency, Pinder also caches non-current arXiv monthly lists and loaded paper metadata in `localStorage` on a best-effort basis.

## Files

- `index.html` — app shell
- `styles.css` — mobile-friendly styling for iPhone and desktop
- `app.js` — swipe logic, local saving, export, undo
- `auth.js` — Firebase Authentication backed sign-in and Firestore sync logic
- `google-api-config.js` — Firebase web app config for Auth and Firestore sync
- `scrape.js` — client-side paper source fetcher/parser used by the app, plus reusable Researchr and DBLP conference scrapers used for ICSE datasets
- `data/icse.json` — hardcoded ICSE 1976–2026 sources together with the scraped paper data
- `scripts/scrape-icse-tracks.js` — Playwright-based collector that opens each ICSE source page and refreshes `data/icse.json`
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

It contains the hardcoded ICSE 1976–2026 source metadata together with all collected paper abstracts.

Examples:

```txt
?source=data/icse.json&track=2026
?source=data/icse.json&track=icse-2024-research-track
```

If `track` is omitted, Pinder uses the collection's `defaultTrack`.

Tap the source label in the header to switch between the default arXiv feed and the ICSE collection.

When an ICSE collection is loaded, the UI also shows an `ICSE year` dropdown in the header so you can switch years without editing the URL manually.

A collapsible `ICSE map` panel also appears above the card stack with one square per ICSE paper across all tracked years, colored by your review decision. Within each ICSE row, squares are sorted left-to-right as accept, weak accept, weak reject, reject, and unreviewed. Hovering a square shows a floating title tooltip near the cursor, and clicking it opens the abstract modal.

The top-right filter menu supports author filtering.

## Regenerating the ICSE datasets

The hardcoded ICSE track URLs and scraped outputs live together in:

- `data/icse.json`

The collector navigates to each conference page with Playwright and runs the reusable scraper function from `scrape.js` inside that page, then writes the updated results back into `data/icse.json`.

Notes on older ICSE years:

- 2018–2026 are scraped from Researchr track pages
- 2009–2017 are scraped from DBLP conference pages, with abstracts resolved from OpenAlex first and then from DOI landing pages in Playwright when the publisher page exposes an abstract
- 1976–2008 are scraped from DBLP proceedings pages, with abstracts resolved from OpenAlex via DOI metadata when available, DOI landing pages as a fallback, and title/year lookup otherwise
- when no abstract can be resolved for some older papers, the dataset stores `No abstract available.`
- ACM DL proceedings URLs are stored in `data/icse.json` for the ACM-era years where we had them as reference metadata (`proceedingsUrl`)

To re-scrape them:

```bash
npm install
npx playwright install chromium
npm run scrape:icse
```

Notes:
- older ICSE years use OpenAlex title lookup as a fallback, including a broader non-year-filtered retry when OpenAlex metadata has the wrong publication year
- legacy DBLP ACM `citation.cfm?id=...` links are normalized into direct ACM DL record URLs (`https://dl.acm.org/doi/10.5555/...`) when the DBLP metadata provides enough information to derive them
- ACM DOI landing-page fallback is disabled by default because `dl.acm.org` may block automated requests; if you explicitly want to try it again later, run with `PINDER_ENABLE_ACM_DOI_FALLBACK=1`

You can also scrape just one year or slug:

```bash
node scripts/scrape-icse-tracks.js 2026
node scripts/scrape-icse-tracks.js icse-2024-research-track
```

To do a targeted second pass over already-derived legacy ACM DL record URLs for older no-DOI papers:

```bash
node scripts/enrich-legacy-acm-abstracts.js
node scripts/enrich-legacy-acm-abstracts.js 1976 1978 1979
```

The ACM enrichment pass is intentionally low-volume and may still stop early if ACM starts returning block pages.

## Firebase login + Firestore sync

Pinder can optionally use Firebase Authentication and Cloud Firestore to sync settings and review outcomes across devices while still being a static GitHub Pages app.

The app stores data under the signed-in Firebase user:

- `users/{uid}/sync/settings`
- `users/{uid}/decisions/arxiv`
- `users/{uid}/decisions/icse`
- `users/{uid}/decisions/fse`

Each decisions document contains a `decisions` map keyed by paper ID.

Setup:

1. Create a Firebase project.
2. Add a web app and paste its config into `google-api-config.js`.
3. Enable Authentication → Google sign-in.
4. Create a Firestore database.
5. Add Firestore rules that restrict each user to their own data:

```js
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

Without Firebase config, the app still works locally with device-only settings.

Firebase Auth persists the user session in the browser and Firestore uses that session automatically, so this does not require Google Sheets or Drive OAuth scopes.

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
