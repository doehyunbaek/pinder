#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ARCHIVE = 'cs.SE';
const LIST_SHOW = 2000;
const LIST_DELAY_MS = Number(process.env.PINDER_ARXIV_LIST_DELAY_MS || 700);
const API_DELAY_MS = Number(process.env.PINDER_ARXIV_API_DELAY_MS || 5000);
const API_BATCH_SIZE = Number(process.env.PINDER_ARXIV_API_BATCH_SIZE || 100);
const RETRY_DELAYS_MS = [15000, 30000, 60000, 90000];
const USER_AGENT = process.env.PINDER_ARXIV_USER_AGENT || 'Pinder/1.0 (arXiv cs.SE dataset refresh; local static paper feed)';

function usage() {
  console.error('Usage: node scripts/scrape-arxiv-years.js <year|startYear endYear> [more years...]');
  console.error('Examples:');
  console.error('  node scripts/scrape-arxiv-years.js 2024 1991');
  console.error('  node scripts/scrape-arxiv-years.js 2024 2023 2022');
}

function parseYears(args) {
  const numericArgs = args.map((arg) => Number(arg)).filter((year) => Number.isInteger(year));
  if (!numericArgs.length) {
    return [];
  }

  if (numericArgs.length === 2 && Math.abs(numericArgs[0] - numericArgs[1]) > 1) {
    const [startYear, endYear] = numericArgs;
    const step = startYear <= endYear ? 1 : -1;
    const years = [];
    for (let year = startYear; step > 0 ? year <= endYear : year >= endYear; year += step) {
      years.push(year);
    }
    return years;
  }

  return Array.from(new Set(numericArgs));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildListUrl(year, month) {
  return `https://arxiv.org/list/${ARCHIVE}/${year}-${String(month).padStart(2, '0')}?skip=0&show=${LIST_SHOW}`;
}

function getOutputPath(year) {
  return path.join(DATA_DIR, `arxiv-se-${year}.json`);
}

function decodeEntity(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
    rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', eacute: 'é', Eacute: 'É', aacute: 'á', Aacute: 'Á',
    oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', iacute: 'í', Iacute: 'Í', agrave: 'à', Agrave: 'À',
    egrave: 'è', Egrave: 'È', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', auml: 'ä', Auml: 'Ä', ccedil: 'ç', Ccedil: 'Ç'
  };

  return String(text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint = entity[1]?.toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, entity) ? named[entity] : match;
  });
}

function stripTags(text) {
  return decodeEntity(String(text || '').replace(/<[^>]*>/g, ' '));
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

function normalizePaperId(rawPaperId) {
  return String(rawPaperId || '')
    .replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/v\d+$/i, '')
    .trim();
}

function getInitialVersionId(id) {
  const normalizedId = normalizePaperId(id);
  return normalizedId ? `${normalizedId}v1` : '';
}

function normalizePdfUrlForId(id, version = '') {
  const versionedId = version ? `${normalizePaperId(id)}${version}` : normalizePaperId(id);
  return `https://arxiv.org/pdf/${versionedId}`;
}

function comparePaperIdsLatestFirst(leftPaperId, rightPaperId) {
  return String(rightPaperId || '').localeCompare(String(leftPaperId || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function firstMatch(text, regex) {
  const match = String(text || '').match(regex);
  return match ? match[1] : '';
}

function parseListPage(html, period) {
  const rowRegex = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  const papers = [];
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html))) {
    const dt = rowMatch[1];
    const dd = rowMatch[2];
    const rawId = firstMatch(dt, /<a\b[^>]*href\s*=\s*["']\/abs\/([^"']+)["'][^>]*>/i);
    const paperId = normalizePaperId(rawId);
    if (!paperId) {
      continue;
    }

    const titleHtml = firstMatch(dd, /<div\b[^>]*class\s*=\s*["'][^"']*list-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const title = cleanText(stripTags(titleHtml)).replace(/^Title:\s*/i, '').trim() || `arXiv:${paperId}`;
    const authorsHtml = firstMatch(dd, /<div\b[^>]*class\s*=\s*["'][^"']*list-authors[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const authors = Array.from(authorsHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi))
      .map((authorMatch) => cleanText(stripTags(authorMatch[1])))
      .filter(Boolean);

    papers.push({
      id: paperId,
      title,
      authors,
      authorsText: authors.join(', '),
      abstract: '',
      absUrl: `https://arxiv.org/abs/${paperId}`,
      pdfUrl: normalizePdfUrlForId(paperId, 'v1'),
      loaded: false,
      loading: false,
      error: '',
      sourceMonth: period,
    });
  }

  return papers.sort((left, right) => comparePaperIdsLatestFirst(left.id, right.id));
}

async function fetchText(url, { accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } = {}) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept,
      },
    });

    if (response.ok) {
      return response.text();
    }

    const body = await response.text().catch(() => '');
    if (attempt >= RETRY_DELAYS_MS.length) {
      throw new Error(`HTTP ${response.status} while fetching ${url}: ${body.slice(0, 200)}`);
    }

    const delay = RETRY_DELAYS_MS[attempt];
    console.log(`HTTP ${response.status} while fetching ${url}; retrying in ${Math.round(delay / 1000)}s`);
    await wait(delay);
  }

  return '';
}

function parseAtomEntries(xml) {
  const entries = new Map();

  for (const entryMatch of String(xml || '').matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const entryXml = entryMatch[1];
    const id = normalizePaperId(stripTags(firstMatch(entryXml, /<id\b[^>]*>([\s\S]*?)<\/id>/i)));
    if (!id) {
      continue;
    }

    const title = cleanText(stripTags(firstMatch(entryXml, /<title\b[^>]*>([\s\S]*?)<\/title>/i)));
    const abstract = cleanText(stripTags(firstMatch(entryXml, /<summary\b[^>]*>([\s\S]*?)<\/summary>/i)));
    const authors = Array.from(entryXml.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi))
      .map((authorMatch) => cleanText(stripTags(authorMatch[1])))
      .filter(Boolean);
    const pdfUrl = cleanText(decodeEntity(firstMatch(entryXml, /<link\b(?=[^>]*rel=["']related["'])(?=[^>]*type=["']application\/pdf["'])[^>]*href=["']([^"']+)["'][^>]*>/i)));

    entries.set(id, {
      id,
      title,
      authors,
      authorsText: authors.join(', '),
      abstract,
      absUrl: `https://arxiv.org/abs/${id}v1`,
      pdfUrl: pdfUrl || normalizePdfUrlForId(id, 'v1'),
      sourceVersion: 'v1',
    });
  }

  return entries;
}

async function fetchAtomBatchDirect(ids) {
  const params = new URLSearchParams({
    id_list: ids.map(getInitialVersionId).filter(Boolean).join(','),
    start: '0',
    max_results: String(ids.length),
  });
  const url = `https://export.arxiv.org/api/query?${params.toString()}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (response.ok) {
      return parseAtomEntries(await response.text());
    }

    const body = await response.text().catch(() => '');
    if (attempt === 1) {
      throw new Error(`HTTP ${response.status} while fetching arXiv API batch of ${ids.length}: ${body.slice(0, 160)}`);
    }

    console.log(`HTTP ${response.status} for arXiv API batch of ${ids.length}; retrying in 15s`);
    await wait(15000);
  }

  return new Map();
}

async function fetchAtomBatch(ids) {
  if (!ids.length) {
    return new Map();
  }

  try {
    return await fetchAtomBatchDirect(ids);
  } catch (error) {
    if (ids.length === 1) {
      console.warn(`Could not resolve ${ids[0]}v1: ${error.message || error}`);
      return new Map();
    }

    const midpoint = Math.ceil(ids.length / 2);
    console.log(`Splitting failed arXiv API batch of ${ids.length} into ${midpoint} + ${ids.length - midpoint}`);
    const leftEntries = await fetchAtomBatch(ids.slice(0, midpoint));
    await wait(API_DELAY_MS);
    const rightEntries = await fetchAtomBatch(ids.slice(midpoint));
    return new Map([...leftEntries, ...rightEntries]);
  }
}

function loadExistingYear(year) {
  const outputPath = getOutputPath(year);
  if (!fs.existsSync(outputPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(outputPath, 'utf8'));
}

function writeYearData(year, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(getOutputPath(year), `${JSON.stringify(data, null, 2)}\n`);
}

function mergeExistingDetails(listPapers, existingData) {
  const existingById = new Map((existingData?.papers || []).map((paper) => [String(paper.id || '').trim(), paper]));

  return listPapers.map((paper) => {
    const existing = existingById.get(paper.id);
    if (!existing || !cleanText(existing.abstract) || existing.sourceVersion !== 'v1') {
      return paper;
    }

    return {
      ...paper,
      title: cleanText(existing.title) || paper.title,
      authors: Array.isArray(existing.authors) && existing.authors.length ? existing.authors : paper.authors,
      authorsText: cleanText(existing.authorsText) || paper.authorsText,
      abstract: cleanText(existing.abstract),
      absUrl: cleanText(existing.absUrl) || paper.absUrl,
      pdfUrl: cleanText(existing.pdfUrl) || paper.pdfUrl,
      sourceVersion: 'v1',
      loaded: true,
      loading: false,
      error: '',
    };
  });
}

async function scrapeYearListings(year) {
  const monthResults = [];
  const seen = new Set();
  const listPapers = [];

  for (let month = 1; month <= 12; month += 1) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    const sourceUrl = buildListUrl(year, month);
    const html = await fetchText(sourceUrl);
    const papers = parseListPage(html, period);
    monthResults.push({ period, sourceUrl, paperCount: papers.length });
    console.log(`${period}: ${papers.length} papers`);

    for (const paper of papers) {
      if (!paper.id || seen.has(paper.id)) {
        continue;
      }
      seen.add(paper.id);
      listPapers.push(paper);
    }

    await wait(LIST_DELAY_MS);
  }

  return {
    months: monthResults,
    papers: listPapers.sort((left, right) => comparePaperIdsLatestFirst(left.id, right.id)),
  };
}

async function enrichYearAbstracts(year, data) {
  const papers = Array.isArray(data.papers) ? data.papers : [];
  const missing = papers.filter((paper) => !cleanText(paper.abstract));
  console.log(`${year}: need abstracts for ${missing.length} of ${papers.length} papers`);

  const idToPaper = new Map(papers.map((paper) => [String(paper.id || '').trim(), paper]));
  let filled = 0;

  for (let start = 0; start < missing.length; start += API_BATCH_SIZE) {
    const ids = missing.slice(start, start + API_BATCH_SIZE).map((paper) => paper.id).filter(Boolean);
    const entries = await fetchAtomBatch(ids);
    const unresolved = [];

    for (const id of ids) {
      const paper = idToPaper.get(id);
      const entry = entries.get(id);
      if (!paper || !entry || !entry.abstract) {
        unresolved.push(id);
        continue;
      }

      paper.title = entry.title || paper.title;
      paper.authors = entry.authors.length ? entry.authors : paper.authors;
      paper.authorsText = entry.authorsText || paper.authorsText;
      paper.abstract = entry.abstract;
      paper.absUrl = entry.absUrl;
      paper.pdfUrl = entry.pdfUrl || paper.pdfUrl;
      paper.sourceVersion = 'v1';
      paper.loaded = true;
      paper.loading = false;
      paper.error = '';
      filled += 1;
    }

    data.updatedAt = new Date().toISOString();
    writeYearData(year, data);
    console.log(`${year}: abstract batch ${Math.floor(start / API_BATCH_SIZE) + 1}/${Math.ceil(missing.length / API_BATCH_SIZE)} filled=${filled} unresolvedInBatch=${unresolved.length}`);

    if (start + API_BATCH_SIZE < missing.length) {
      await wait(API_DELAY_MS);
    }
  }

  const remaining = papers.filter((paper) => !cleanText(paper.abstract)).length;
  console.log(`${year}: remaining missing abstracts ${remaining}`);
}

async function scrapeYear(year) {
  console.log(`\n=== arXiv ${ARCHIVE} ${year} ===`);
  const existingData = loadExistingYear(year);
  const { months, papers: listPapers } = await scrapeYearListings(year);
  const papers = mergeExistingDetails(listPapers, existingData);
  const data = {
    title: `arXiv ${ARCHIVE} ${year}`,
    sourceLabel: `arXiv ${ARCHIVE} ${year}`,
    sourceUrl: `https://arxiv.org/list/${ARCHIVE}/${year}`,
    archive: ARCHIVE,
    year,
    updatedAt: new Date().toISOString(),
    months,
    papers,
  };

  writeYearData(year, data);
  await enrichYearAbstracts(year, data);
}

async function main() {
  const years = parseYears(process.argv.slice(2));
  if (!years.length) {
    usage();
    process.exit(1);
  }

  for (const year of years) {
    await scrapeYear(year);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
