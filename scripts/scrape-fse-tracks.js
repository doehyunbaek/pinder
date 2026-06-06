#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '..');
const FSE_DATA_PATH = path.join(ROOT_DIR, 'data', 'fse.json');
const SCRAPER_PATH = path.join(ROOT_DIR, 'scrape.js');
const PLAYWRIGHT_CONTEXT_OPTIONS = {
  bypassCSP: true,
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  viewport: {
    width: 1365,
    height: 833,
  },
};
const ENABLE_ACM_DOI_FALLBACK = process.env.PINDER_ENABLE_ACM_DOI_FALLBACK === '1';
const DOI_ABSTRACT_CANDIDATE_SELECTORS = [
  'meta[name="citation_abstract"]',
  'meta[name="dc.Description"]',
  'meta[name="dc.description"]',
  'meta[name="twitter:description"]',
  'meta[property="og:description"]',
  'section#abstract',
  '#abstract',
  'div.abstract-text',
  'div.abstractSection',
  '.abstractInFull',
  '#abstract-text',
  '.article__abstract',
  '.abstract-content',
  '.c-article-section__content',
];

async function loadFseCollection() {
  return JSON.parse(await fs.readFile(FSE_DATA_PATH, 'utf8'));
}

async function saveFseCollection(collection) {
  const nextCollection = {
    ...collection,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(FSE_DATA_PATH, JSON.stringify(nextCollection, null, 2));
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

function cleanText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeAbstractText(text) {
  return cleanText(text)
    .replace(/^Abstract\b\s*[:.]?\s*/i, '')
    .replace(/^Abstract(?=[A-Z])/i, '')
    .replace(/^Summary\b\s*[:.]?\s*/i, '')
    .replace(/([a-z0-9)][.?!])([A-Z])/g, '$1 $2');
}

function isMissingAbstract(text) {
  const normalizedText = normalizeAbstractText(text);
  return !normalizedText || /^No abstract available\.?$/i.test(normalizedText);
}

function isCloudflareInterstitial(pageTitle, pageText) {
  const normalizedTitle = cleanText(pageTitle).toLowerCase();
  const normalizedText = cleanText(pageText).toLowerCase();
  return normalizedTitle.includes('just a moment')
    || normalizedTitle.includes('attention required')
    || normalizedText.includes('enable javascript and cookies to continue')
    || normalizedText.includes('please verify you are a human');
}

function isPlausibleAbstract(text, pageTitle = '') {
  const normalizedText = normalizeAbstractText(text);
  const normalizedTitle = cleanText(pageTitle);
  const lowerText = normalizedText.toLowerCase();

  if (!normalizedText || normalizedText.length < 60) {
    return false;
  }

  if (normalizedTitle && normalizedText.toLowerCase() === normalizedTitle.toLowerCase()) {
    return false;
  }

  return ![
    'aboutthis website uses cookies',
    'this website uses cookies',
    'use cookies to track post-clicks',
    'advertising and analytics partners',
    'enable javascript and cookies to continue',
    'please verify you are a human',
    'you are not authorized to access this page',
  ].some((fragment) => lowerText.includes(fragment));
}

async function addStealthToContext(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    window.chrome = window.chrome || {
      runtime: {},
    };

    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }
  });
}

async function waitForDoiLandingPage(page) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const pageTitle = cleanText(await page.title().catch(() => ''));
    const pageText = cleanText(await page.textContent('body').catch(() => ''));
    if (!isCloudflareInterstitial(pageTitle, pageText)) {
      return;
    }

    await page.waitForTimeout(2000);
  }
}

async function extractAbstractFromPage(page) {
  const pageTitle = cleanText(await page.title().catch(() => ''));
  const candidates = await page.evaluate((selectors) => {
    const extractNodeText = (node) => {
      if (!node) {
        return '';
      }

      if (typeof node.getAttribute === 'function') {
        return node.getAttribute('content') || node.textContent || '';
      }

      return node.textContent || '';
    };

    return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))
      .map((node) => extractNodeText(node))
      .filter(Boolean));
  }, DOI_ABSTRACT_CANDIDATE_SELECTORS);

  const abstract = candidates
    .map((candidate) => normalizeAbstractText(candidate))
    .find((candidate) => isPlausibleAbstract(candidate, pageTitle));

  return abstract || '';
}

async function createStealthContext(browser) {
  const context = await browser.newContext(PLAYWRIGHT_CONTEXT_OPTIONS);
  await addStealthToContext(context);
  return context;
}

async function resolveAbstractFromDoi(browser, paper) {
  const context = await createStealthContext(browser);
  const page = await context.newPage();

  try {
    await page.goto(paper.doiUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await waitForDoiLandingPage(page);

    const pageTitle = cleanText(await page.title().catch(() => ''));
    const pageText = cleanText(await page.textContent('body').catch(() => ''));
    if (isCloudflareInterstitial(pageTitle, pageText)) {
      throw new Error('DOI landing page stayed behind an anti-bot challenge.');
    }

    const abstract = await extractAbstractFromPage(page);
    if (!abstract) {
      return null;
    }

    return {
      abstract,
      absUrl: cleanText(page.url() || paper.absUrl || paper.doiUrl),
    };
  } finally {
    await context.close();
  }
}

function shouldAttemptDoiEnrichment(paper) {
  const doi = String(paper?.doiUrl || '').replace(/^https?:\/\/doi\.org\//i, '').trim().toLowerCase();
  if (!doi) {
    return false;
  }

  if (doi.startsWith('10.1145/')) {
    return ENABLE_ACM_DOI_FALLBACK && isMissingAbstract(paper?.abstract);
  }

  return isMissingAbstract(paper?.abstract)
    || doi.startsWith('10.1109/');
}

function mergeTrackPapers(existingPapers = [], nextPapers = []) {
  const existingPapersById = new Map(existingPapers.map((paper) => [String(paper?.id || ''), paper]));

  return nextPapers.map((nextPaper) => {
    const existingPaper = existingPapersById.get(String(nextPaper?.id || ''));
    if (!existingPaper) {
      return nextPaper;
    }

    const existingAbstract = normalizeAbstractText(existingPaper.abstract);
    const nextAbstract = normalizeAbstractText(nextPaper.abstract);
    const existingAbsUrl = cleanText(existingPaper.absUrl);
    const nextAbsUrl = cleanText(nextPaper.absUrl);
    const shouldKeepExistingAbstract = existingAbstract && (
      isMissingAbstract(nextAbstract)
      || existingAbstract.length > nextAbstract.length + 80
    );
    const shouldKeepExistingAbsUrl = existingAbsUrl
      && nextAbsUrl
      && /^https?:\/\/doi\.org\//i.test(nextAbsUrl)
      && !/^https?:\/\/doi\.org\//i.test(existingAbsUrl);

    if (!shouldKeepExistingAbstract && !shouldKeepExistingAbsUrl) {
      return nextPaper;
    }

    return {
      ...nextPaper,
      abstract: shouldKeepExistingAbstract ? existingAbstract : nextPaper.abstract,
      absUrl: shouldKeepExistingAbstract || shouldKeepExistingAbsUrl ? existingAbsUrl : nextPaper.absUrl,
    };
  });
}

async function enrichMissingDoiAbstracts(payload, browser, { trackYear = '' } = {}) {
  const papers = Array.isArray(payload?.papers) ? payload.papers : [];
  const candidates = papers
    .map((paper, index) => ({ paper, index }))
    .filter(({ paper }) => shouldAttemptDoiEnrichment(paper));

  if (!candidates.length) {
    return payload;
  }

  let nextIndex = 0;
  let completed = 0;
  let recovered = 0;
  const concurrency = Math.min(2, candidates.length);

  async function worker() {
    while (nextIndex < candidates.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const { paper, index } = candidates[currentIndex];

      try {
        const resolvedPaper = await resolveAbstractFromDoi(browser, paper);
        const currentAbstract = normalizeAbstractText(paper?.abstract);
        const resolvedAbstract = normalizeAbstractText(resolvedPaper?.abstract);
        if (resolvedAbstract && (
          isMissingAbstract(currentAbstract)
          || resolvedAbstract.length > currentAbstract.length + 80
          || (resolvedAbstract !== currentAbstract && resolvedAbstract.length >= currentAbstract.length)
          || cleanText(resolvedPaper?.absUrl) !== cleanText(paper?.absUrl)
        )) {
          papers[index] = {
            ...paper,
            ...resolvedPaper,
            abstract: resolvedAbstract,
          };
          recovered += 1;
        }
      } catch (error) {
        console.log(`${trackYear}: DOI fallback failed for ${paper.doiUrl} (${error.message || 'unknown error'})`);
      }

      completed += 1;
      console.log(`${trackYear}: DOI fallback ${completed}/${candidates.length} (${recovered} updated)`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    ...payload,
    papers,
  };
}

async function main() {
  const selectedTrackKeys = new Set(process.argv.slice(2));
  const collection = await loadFseCollection();
  const tracks = selectTracks(collection, selectedTrackKeys);

  if (!tracks.length) {
    throw new Error(`No FSE tracks matched: ${Array.from(selectedTrackKeys).join(', ') || '(none)'}`);
  }

  const scraperSource = await fs.readFile(SCRAPER_PATH, 'utf8');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await createStealthContext(browser);

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

        if (track.scraper === 'dblp') {
          await page.waitForSelector('li.entry.inproceedings', {
            state: 'attached',
            timeout: 120000,
          });
        } else {
          await page.waitForSelector('#event-overview table', {
            state: 'attached',
            timeout: 120000,
          });
        }

        await page.addScriptTag({ content: scraperSource });

        let payload = await page.evaluate(async (trackEntry) => {
          const scraperName = trackEntry.scraper === 'dblp'
            ? 'scrapeCurrentDblpConferencePage'
            : 'scrapeCurrentResearchrTrack';

          return window.PinderScraper[scraperName]({
            sourceUrl: trackEntry.trackUrl,
            sourceLabel: trackEntry.sourceLabel,
            sectionTitle: trackEntry.sectionTitle || '',
            includeSectionTitlePrefixes: Array.isArray(trackEntry.includeSectionTitlePrefixes)
              ? trackEntry.includeSectionTitlePrefixes
              : [],
            excludeSectionTitlePrefixes: Array.isArray(trackEntry.excludeSectionTitlePrefixes)
              ? trackEntry.excludeSectionTitlePrefixes
              : [],
            minPageCount: Number(trackEntry.minPageCount) || 0,
            maxPageEnd: Number(trackEntry.maxPageEnd) || 0,
            publicationYear: Number(trackEntry.year) || 0,
            concurrency: trackEntry.scraper === 'dblp' ? 4 : 8,
            onProgress: (message) => window.__pinderTrackProgress(`${trackEntry.year}: ${message}`),
          });
        }, track);

        if (track.scraper === 'dblp') {
          payload = await enrichMissingDoiAbstracts(payload, browser, {
            trackYear: String(track.year || track.slug || ''),
          });
        }

        const currentCollection = await loadFseCollection();
        currentCollection.tracks = (currentCollection.tracks || []).map((entry) => {
          if (entry.slug !== track.slug) {
            return entry;
          }

          return {
            ...entry,
            scraper: track.scraper || entry.scraper || 'researchr',
            sectionTitle: track.sectionTitle || entry.sectionTitle || '',
            includeSectionTitlePrefixes: Array.isArray(track.includeSectionTitlePrefixes)
              ? track.includeSectionTitlePrefixes
              : (Array.isArray(entry.includeSectionTitlePrefixes) ? entry.includeSectionTitlePrefixes : []),
            excludeSectionTitlePrefixes: Array.isArray(track.excludeSectionTitlePrefixes)
              ? track.excludeSectionTitlePrefixes
              : (Array.isArray(entry.excludeSectionTitlePrefixes) ? entry.excludeSectionTitlePrefixes : []),
            minPageCount: Number(track.minPageCount) || Number(entry.minPageCount) || 0,
            maxPageEnd: Number(track.maxPageEnd) || Number(entry.maxPageEnd) || 0,
            sourceLabel: payload.sourceLabel || entry.sourceLabel,
            trackUrl: track.trackUrl,
            proceedingsUrl: track.proceedingsUrl || entry.proceedingsUrl || '',
            collectedAt: payload.collectedAt,
            paperCount: payload.paperCount,
            papers: mergeTrackPapers(entry.papers, payload.papers),
          };
        });
        await saveFseCollection(currentCollection);
        console.log(`Updated data/fse.json → ${track.slug} (${payload.paperCount} papers)`);
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
