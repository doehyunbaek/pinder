#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '..');
const ICSE_DATA_PATH = path.join(ROOT_DIR, 'data', 'icse.json');
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
const REQUEST_DELAY_MS = Number(process.env.PINDER_ACM_DELAY_MS || 3000);
const ABSTRACT_SELECTORS = [
  'meta[name="citation_abstract"]',
  'meta[name="dc.Description"]',
  'meta[name="dc.description"]',
  'meta[name="twitter:description"]',
  'meta[property="og:description"]',
  'section#abstract',
  '#abstract',
  'div.abstractSection',
  '.abstractInFull',
  '.article__abstract',
  '.abstract-content',
  '.c-article-section__content',
];

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

function isBlockedPage(pageTitle, pageText) {
  const normalizedTitle = cleanText(pageTitle).toLowerCase();
  const normalizedText = cleanText(pageText).toLowerCase();
  return normalizedTitle.includes('just a moment')
    || normalizedTitle.includes('attention required')
    || normalizedTitle.includes('acm error: ip blocked')
    || normalizedText.includes('enable javascript and cookies to continue')
    || normalizedText.includes('please verify you are a human')
    || normalizedText.includes('your ip address has been blocked');
}

function isPlausibleAbstract(text, pageTitle = '') {
  const normalizedText = normalizeAbstractText(text);
  const normalizedTitle = cleanText(pageTitle);
  const lowerText = normalizedText.toLowerCase();

  if (!normalizedText || normalizedText.length < 40) {
    return false;
  }

  if (normalizedTitle && normalizedText.toLowerCase() === normalizedTitle.toLowerCase()) {
    return false;
  }

  return ![
    'this website uses cookies',
    'use cookies to track post-clicks',
    'advertising and analytics partners',
    'enable javascript and cookies to continue',
    'please verify you are a human',
    'your ip address has been blocked',
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

async function createContext(browser) {
  const context = await browser.newContext(PLAYWRIGHT_CONTEXT_OPTIONS);
  await addStealthToContext(context);
  return context;
}

async function waitForLandingPage(page) {
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const pageTitle = cleanText(await page.title().catch(() => ''));
    const pageText = cleanText(await page.textContent('body').catch(() => ''));
    if (!isBlockedPage(pageTitle, pageText)) {
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
  }, ABSTRACT_SELECTORS);

  return candidates
    .map((candidate) => normalizeAbstractText(candidate))
    .find((candidate) => isPlausibleAbstract(candidate, pageTitle)) || '';
}

function getLegacyAcmUrlForPaper(paper) {
  if (cleanText(paper.acmDlUrl)) {
    return cleanText(paper.acmDlUrl);
  }

  const normalizedDoiUrl = cleanText(paper.doiUrl);
  if (/^https?:\/\/doi\.org\/10\.5555\//i.test(normalizedDoiUrl)) {
    return normalizedDoiUrl.replace(/^https?:\/\/doi\.org\//i, 'https://dl.acm.org/doi/');
  }

  const acmLink = (Array.isArray(paper.publicationLinks) ? paper.publicationLinks : [])
    .find((link) => cleanText(link.label) === 'ACM DL');
  return cleanText(acmLink?.href || '');
}

async function resolveAbstractFromLegacyAcmUrl(browser, targetUrl) {
  const context = await createContext(browser);
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await waitForLandingPage(page);

    const pageTitle = cleanText(await page.title().catch(() => ''));
    const pageText = cleanText(await page.textContent('body').catch(() => ''));
    if (isBlockedPage(pageTitle, pageText)) {
      throw new Error('ACM landing page stayed behind an anti-bot or block page.');
    }

    const abstract = await extractAbstractFromPage(page);
    if (!abstract) {
      return null;
    }

    return {
      abstract,
      absUrl: cleanText(page.url() || targetUrl),
    };
  } finally {
    await context.close();
  }
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
  const targets = [];

  tracks.forEach((track) => {
    (track.papers || []).forEach((paper, paperIndex) => {
      const targetUrl = getLegacyAcmUrlForPaper(paper);
      if (!targetUrl || !isMissingAbstract(paper.abstract)) {
        return;
      }

      targets.push({
        track,
        paper,
        paperIndex,
        targetUrl,
      });
    });
  });

  if (!targets.length) {
    console.log('No legacy ACM papers with missing abstracts found.');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let completed = 0;
  let updated = 0;
  let consecutiveBlocks = 0;

  try {
    for (const target of targets) {
      try {
        const resolved = await resolveAbstractFromLegacyAcmUrl(browser, target.targetUrl);
        if (resolved?.abstract) {
          target.paper.abstract = normalizeAbstractText(resolved.abstract);
          target.paper.absUrl = resolved.absUrl;
          updated += 1;
          consecutiveBlocks = 0;
          console.log(`${target.track.year}: updated ${target.paper.title}`);

          if (updated % 5 === 0) {
            await saveIcseCollection(collection);
          }
        } else {
          consecutiveBlocks = 0;
          console.log(`${target.track.year}: no abstract found ${target.paper.title}`);
        }
      } catch (error) {
        const message = error?.message || 'unknown error';
        const blocked = /anti-bot|block page|ip blocked|just a moment/i.test(message);
        consecutiveBlocks = blocked ? (consecutiveBlocks + 1) : 0;
        console.log(`${target.track.year}: failed ${target.paper.title} (${message})`);
        if (consecutiveBlocks >= 5) {
          throw new Error('Stopping after repeated ACM block pages.');
        }
      }

      completed += 1;
      console.log(`Progress ${completed}/${targets.length} (${updated} updated)`);
      if (REQUEST_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
      }
    }
  } finally {
    await saveIcseCollection(collection);
    await browser.close();
  }

  console.log(`Saved data/icse.json (${updated} abstracts updated)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
