#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '..');
const ICSE_DATA_PATH = path.join(ROOT_DIR, 'data', 'icse.json');
const SCRAPER_PATH = path.join(ROOT_DIR, 'scrape.js');

async function loadIcseCollection() {
  return JSON.parse(await fs.readFile(ICSE_DATA_PATH, 'utf8'));
}

async function saveIcseCollection(collection) {
  const nextCollection = {
    ...collection,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(ICSE_DATA_PATH, JSON.stringify(nextCollection, null, 2));
}

function selectTracks(collection, selectedTrackKeys) {
  const allTracks = Array.isArray(collection?.tracks) ? collection.tracks : [];
  return allTracks.filter((track) => {
    if (!selectedTrackKeys.size) {
      return true;
    }

    return selectedTrackKeys.has(String(track.year))
      || selectedTrackKeys.has(String(track.slug || ''))
      || selectedTrackKeys.has(String(track.sourceLabel || ''))
      || selectedTrackKeys.has(String(track.trackUrl || ''));
  });
}

async function main() {
  const selectedTrackKeys = new Set(process.argv.slice(2));
  const collection = await loadIcseCollection();
  const tracks = selectTracks(collection, selectedTrackKeys);

  if (!tracks.length) {
    throw new Error(`No ICSE tracks matched: ${Array.from(selectedTrackKeys).join(', ') || '(none)'}`);
  }

  const scraperSource = await fs.readFile(SCRAPER_PATH, 'utf8');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ bypassCSP: true });

  await context.exposeFunction('__pinderTrackProgress', (message) => {
    console.log(message);
  });

  try {
    for (const track of tracks) {
      const page = await context.newPage();
      try {
        console.log(`\n=== ${track.sourceLabel} ===`);
        await page.goto(track.trackUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 120000,
        });
        await page.waitForSelector('#event-overview table', {
          state: 'attached',
          timeout: 120000,
        });
        await page.addScriptTag({ content: scraperSource });

        const payload = await page.evaluate(async (trackEntry) => {
          return window.PinderScraper.scrapeCurrentResearchrTrack({
            sourceUrl: trackEntry.trackUrl,
            sourceLabel: trackEntry.sourceLabel,
            concurrency: 8,
            onProgress: (message) => window.__pinderTrackProgress(`${trackEntry.year}: ${message}`),
          });
        }, track);

        const currentCollection = await loadIcseCollection();
        currentCollection.tracks = (currentCollection.tracks || []).map((entry) => {
          if (entry.slug !== track.slug) {
            return entry;
          }

          return {
            ...entry,
            sourceLabel: payload.sourceLabel || entry.sourceLabel,
            trackUrl: track.trackUrl,
            collectedAt: payload.collectedAt,
            paperCount: payload.paperCount,
            papers: payload.papers,
          };
        });
        await saveIcseCollection(currentCollection);
        console.log(`Updated data/icse.json → ${track.slug} (${payload.paperCount} papers)`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
