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
- `app.js` — swipe logic, local saving, export, undo
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
