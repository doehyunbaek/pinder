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
- `scrape.js` — client-side arXiv fetcher/parser used by the app

## Paper source

By default the app fetches papers from the current browser year-month in `cs.SE`, for example:

`https://arxiv.org/list/cs.SE/YYYY-MM?skip=0&show=2000`

It fetches papers dynamically in the browser through `scrape.js`, and shows the newest papers first for that month.

You can override the source list URL with a query parameter:

```txt
?source=https://arxiv.org/list/cs.SE/2026-04?skip=0&show=2000
```

Because arXiv does not expose browser-friendly CORS headers for this workflow, `scrape.js` uses a public CORS proxy to read arXiv pages client-side.

## Google login + Google Sheets sync

Pinder can optionally use Google login and the user's own Google Sheet to sync settings and review outcomes across devices while still being a static GitHub Pages app.

The app creates or reuses a spreadsheet named `Pinder Sync` in the signed-in user's Google Drive and stores:

- settings in the `settings` tab
- review outcomes in the `decisions` tab

Review outcomes are keyed by the paper's arXiv abstract URL.

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

The app is fully client-side and fetches arXiv data dynamically in the browser.
