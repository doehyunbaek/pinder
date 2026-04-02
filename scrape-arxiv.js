#!/usr/bin/env node

const fs = require('node:fs/promises');

const DEFAULT_LIST_URL = 'https://arxiv.org/list/cs.SE/2026-03?skip=0&show=2000';
const DEFAULT_OUTPUT = 'papers.json';
const DEFAULT_CONCURRENCY = 8;
const USER_AGENT = 'pinder-scraper/1.0';

main().catch((error) => {
  console.error('\nScrape failed.');
  console.error(error);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const listUrl = args.url || args.positionals[0] || DEFAULT_LIST_URL;
  const outputPath = args.output || args.positionals[1] || DEFAULT_OUTPUT;
  const limit = args.limit ? Number(args.limit) : undefined;
  const concurrency = args.concurrency ? Number(args.concurrency) : DEFAULT_CONCURRENCY;

  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`Invalid --limit value: ${args.limit}`);
  }

  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    throw new Error(`Invalid --concurrency value: ${args.concurrency}`);
  }

  console.log(`Fetching list page: ${listUrl}`);
  const listHtml = await fetchText(listUrl);
  let papers = parseListPage(listHtml);

  if (!papers.length) {
    throw new Error('No papers were found on the arXiv list page.');
  }

  if (limit !== undefined) {
    papers = papers.slice(0, limit);
  }

  console.log(`Found ${papers.length} papers. Fetching abstracts with concurrency ${concurrency}…`);

  let completed = 0;
  const failures = [];
  const startedAt = Date.now();

  const enrichedPapers = await mapLimit(papers, concurrency, async (paper, index) => {
    try {
      const abstractHtml = await fetchText(paper.absUrl);
      const abstract = parseAbstractPage(abstractHtml);

      if (!abstract) {
        failures.push({ id: paper.id, reason: 'Abstract block not found.' });
      }

      return {
        ...paper,
        abstract,
      };
    } catch (error) {
      failures.push({ id: paper.id, reason: error.message });
      return {
        ...paper,
        abstract: '',
      };
    } finally {
      completed += 1;
      if (completed === 1 || completed === papers.length || completed % 25 === 0) {
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[${completed}/${papers.length}] ${paper.id} (${elapsedSeconds}s elapsed)`);
      }
    }
  });

  const payload = {
    scrapedAt: new Date().toISOString(),
    sourceUrl: listUrl,
    count: enrichedPapers.length,
    failures,
    papers: enrichedPapers,
  };

  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`Saved ${enrichedPapers.length} papers to ${outputPath}`);
  if (failures.length) {
    console.log(`Completed with ${failures.length} missing abstracts.`);
  }
}

function parseArgs(argv) {
  const args = { positionals: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help' || argument === '-h') {
      args.help = true;
      continue;
    }

    if (argument === '--url' || argument === '-u') {
      args.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--url=')) {
      args.url = argument.slice('--url='.length);
      continue;
    }

    if (argument === '--output' || argument === '-o') {
      args.output = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--output=')) {
      args.output = argument.slice('--output='.length);
      continue;
    }

    if (argument === '--limit' || argument === '-l') {
      args.limit = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--limit=')) {
      args.limit = argument.slice('--limit='.length);
      continue;
    }

    if (argument === '--concurrency' || argument === '-c') {
      args.concurrency = argv[index + 1];
      index += 1;
      continue;
    }

    if (argument.startsWith('--concurrency=')) {
      args.concurrency = argument.slice('--concurrency='.length);
      continue;
    }

    args.positionals.push(argument);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scrape-arxiv.js
  node scrape-arxiv.js --url <arxiv-list-url> --output papers.json
  node scrape-arxiv.js --limit 25 --concurrency 4

Defaults:
  url         ${DEFAULT_LIST_URL}
  output      ${DEFAULT_OUTPUT}
  concurrency ${DEFAULT_CONCURRENCY}
`);
}

async function fetchText(url, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return await response.text();
  } catch (error) {
    if (attempt >= 3) {
      throw error;
    }

    await wait(attempt * 700);
    return fetchText(url, attempt + 1);
  }
}

function parseListPage(html) {
  const articleRegex = /<dt>[\s\S]*?<a href\s*=\s*"\/abs\/([^"]+)"[^>]*>[\s\S]*?<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
  const papers = [];
  let match;

  while ((match = articleRegex.exec(html))) {
    const id = match[1].trim();
    const ddHtml = match[2];
    const titleHtml = matchFirst(ddHtml, /<div class=['"]list-title[^>]*>[\s\S]*?<span class=['"]descriptor['"]>Title:<\/span>([\s\S]*?)<\/div>/i);
    const authorsHtml = matchFirst(ddHtml, /<div class=['"]list-authors['"]>([\s\S]*?)<\/div>/i);

    const title = cleanText(titleHtml);
    const authorsText = cleanText(authorsHtml).replace(/\s*,\s*/g, ', ');
    const authors = authorsText ? authorsText.split(/\s*,\s*/).filter(Boolean) : [];

    papers.push({
      id,
      title,
      authors,
      authorsText,
      absUrl: new URL(`/abs/${id}`, 'https://arxiv.org').toString(),
      pdfUrl: new URL(`/pdf/${id}`, 'https://arxiv.org').toString(),
    });
  }

  return papers;
}

function parseAbstractPage(html) {
  const abstractHtml =
    matchFirst(html, /<blockquote class=['"]abstract mathjax['"]>([\s\S]*?)<\/blockquote>/i) || '';

  return cleanText(
    abstractHtml.replace(/<span class=['"]descriptor['"]>\s*Abstract:\s*<\/span>/i, ''),
  );
}

function matchFirst(text, regex) {
  return text.match(regex)?.[1] || '';
}

function cleanText(html) {
  return decodeHtmlEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00a0/g, ' '),
  )
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

function decodeHtmlEntities(text) {
  const namedEntities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    hellip: '…',
    middot: '·',
    bull: '•',
    copy: '©',
    reg: '®',
    trade: '™',
    deg: '°',
    plusmn: '±',
    micro: 'µ',
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    lambda: 'λ',
    pi: 'π',
    sigma: 'σ',
    tau: 'τ',
    phi: 'φ',
    omega: 'ω',
    Auml: 'Ä',
    auml: 'ä',
    Ouml: 'Ö',
    ouml: 'ö',
    Uuml: 'Ü',
    uuml: 'ü',
    Eacute: 'É',
    eacute: 'é',
    Egrave: 'È',
    egrave: 'è',
    Aacute: 'Á',
    aacute: 'á',
    Agrave: 'À',
    agrave: 'à',
    Iacute: 'Í',
    iacute: 'í',
    Oacute: 'Ó',
    oacute: 'ó',
    Uacute: 'Ú',
    uacute: 'ú',
    Ntilde: 'Ñ',
    ntilde: 'ñ',
    Ccedil: 'Ç',
    ccedil: 'ç',
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1]?.toLowerCase() === 'x';
      const value = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }

    return Object.prototype.hasOwnProperty.call(namedEntities, entity)
      ? namedEntities[entity]
      : match;
  });
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
