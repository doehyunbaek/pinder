(() => {
  const DEFAULT_LIST_URL = buildDefaultListUrl();
  const REQUEST_TIMEOUT_MS = 30000;
  const PAPER_CACHE = new Map();
  const EARLIEST_ARXIV_YEAR = 1991;
  const PROXY_BUILDERS = [
    (targetUrl) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(targetUrl)}`,
    (targetUrl) => `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
  ];

  function buildDefaultListUrl(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `https://arxiv.org/list/cs.SE/${year}-${month}?skip=0&show=2000`;
  }

  function describeListUrl(listUrl) {
    if (!listUrl) {
      return null;
    }

    try {
      const parsedUrl = new URL(listUrl, window.location.href);
      const match = parsedUrl.pathname.match(/^\/list\/([^/]+)\/(\d{4})-(\d{2})\/?$/i);
      if (!match) {
        return null;
      }

      const archive = match[1];
      const year = Number(match[2]);
      const month = Number(match[3]);
      if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
        return null;
      }

      const skip = Number(parsedUrl.searchParams.get('skip') || 0);
      const show = Number(parsedUrl.searchParams.get('show') || 2000);

      return {
        archive,
        year,
        month,
        period: `${match[2]}-${match[3]}`,
        skip: Number.isFinite(skip) ? Math.max(0, skip) : 0,
        show: Number.isFinite(show) ? Math.max(1, show) : 2000,
      };
    } catch (error) {
      return null;
    }
  }

  function buildListUrl({ archive, year, month, skip = 0, show = 2000 }) {
    const normalizedMonth = String(month).padStart(2, '0');
    return `https://arxiv.org/list/${archive}/${year}-${normalizedMonth}?skip=${skip}&show=${show}`;
  }

  function getPreviousListUrl(listUrl) {
    const parsed = describeListUrl(listUrl);
    if (!parsed) {
      return '';
    }

    let { year, month } = parsed;
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }

    if (year < EARLIEST_ARXIV_YEAR) {
      return '';
    }

    return buildListUrl({
      archive: parsed.archive,
      year,
      month,
      skip: parsed.skip,
      show: parsed.show,
    });
  }

  function createPaperStub(id) {
    return {
      id,
      title: '',
      authors: [],
      authorsText: '',
      abstract: '',
      absUrl: `https://arxiv.org/abs/${id}`,
      pdfUrl: `https://arxiv.org/pdf/${id}`,
      loaded: false,
      loading: false,
      error: '',
    };
  }

  async function fetchPaperList({ listUrl = DEFAULT_LIST_URL, allowEmpty = false, onProgress = () => {} } = {}) {
    onProgress('Fetching paper list from arXiv…');
    const html = await fetchThroughProxy(listUrl);
    const papers = parseListPage(html);

    if (!papers.length && !allowEmpty) {
      throw new Error('Could not parse any papers from the arXiv list page.');
    }

    return {
      sourceUrl: listUrl,
      papers,
    };
  }

  async function ensurePaperLoaded(paper, { onProgress = () => {} } = {}) {
    if (!paper) {
      return null;
    }

    if (paper.loaded) {
      return paper;
    }

    if (PAPER_CACHE.has(paper.id)) {
      const cachedPaper = await PAPER_CACHE.get(paper.id);
      Object.assign(paper, cachedPaper, { loaded: true, loading: false, error: '' });
      return paper;
    }

    paper.loading = true;
    onProgress(`Loading ${paper.id}…`);

    const fetchPromise = fetchAndParsePaper(paper);
    PAPER_CACHE.set(paper.id, fetchPromise);

    try {
      const loadedPaper = await fetchPromise;
      Object.assign(paper, loadedPaper, { loaded: true, loading: false, error: '' });
      return paper;
    } catch (error) {
      PAPER_CACHE.delete(paper.id);
      paper.loading = false;
      paper.error = error.message || 'Could not load paper details.';
      paper.title = paper.title || `arXiv:${paper.id}`;
      paper.abstract = paper.abstract || 'Could not load abstract.';
      return paper;
    }
  }

  async function prefetchPapers(papers, { startIndex = 0, count = 3, concurrency = 2, onProgress = () => {} } = {}) {
    const candidates = papers
      .slice(startIndex, startIndex + count)
      .filter((paper) => paper && !paper.loaded && !paper.loading);

    let nextIndex = 0;

    async function worker() {
      while (nextIndex < candidates.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        await ensurePaperLoaded(candidates[currentIndex], { onProgress });
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  }

  async function fetchAndParsePaper(paper) {
    const html = await fetchThroughProxy(paper.absUrl);
    const parsedPaper = parseAbstractPage(html, paper.id);

    return {
      ...paper,
      ...parsedPaper,
      loaded: true,
      loading: false,
      error: '',
    };
  }

  async function fetchThroughProxy(targetUrl) {
    let lastError = null;

    for (const buildProxyUrl of PROXY_BUILDERS) {
      const proxyUrl = buildProxyUrl(targetUrl);
      try {
        return await fetchText(proxyUrl);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(`Could not fetch ${targetUrl}`);
  }

  async function fetchText(url, attempt = 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        cache: 'no-store',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${url}`);
      }

      return await response.text();
    } catch (error) {
      if (attempt >= 2) {
        throw error;
      }

      await wait(attempt * 700);
      return fetchText(url, attempt + 1);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function parseListPage(html) {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const rows = Array.from(document.querySelectorAll('#articles > dt'));

    return rows
      .map((dt) => {
        const dd = dt.nextElementSibling;
        const abstractLink = dt.querySelector('a[href^="/abs/"]');
        const rawId = abstractLink?.getAttribute('href')?.replace('/abs/', '') || '';
        const paperId = normalizePaperId(rawId);

        if (!paperId || !dd) {
          return null;
        }

        const title = cleanText(dd.querySelector('.list-title')?.textContent || '').replace(/^Title:\s*/i, '');
        const authors = Array.from(dd.querySelectorAll('.list-authors a'))
          .map((authorLink) => cleanText(authorLink.textContent))
          .filter(Boolean);
        const authorsText = authors.join(', ');

        return {
          id: paperId,
          title: title || `arXiv:${paperId}`,
          authors,
          authorsText,
          abstract: '',
          absUrl: `https://arxiv.org/abs/${paperId}`,
          pdfUrl: `https://arxiv.org/pdf/${paperId}`,
          loaded: false,
          loading: false,
          error: '',
        };
      })
      .filter(Boolean)
      .sort((leftPaper, rightPaper) => comparePaperIdsLatestFirst(leftPaper.id, rightPaper.id));
  }

  function parseAbstractPage(html, fallbackPaperId) {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const title = cleanText(document.querySelector('h1.title')?.textContent || '').replace(/^Title:\s*/i, '');
    const authors = Array.from(document.querySelectorAll('.authors a'))
      .map((authorLink) => cleanText(authorLink.textContent))
      .filter(Boolean);
    const authorsText = authors.join(', ');
    const abstract = cleanText(document.querySelector('blockquote.abstract')?.textContent || '')
      .replace(/^Abstract:\s*/i, '');

    return {
      id: fallbackPaperId,
      title: title || `arXiv:${fallbackPaperId}`,
      authors,
      authorsText,
      abstract,
      absUrl: `https://arxiv.org/abs/${fallbackPaperId}`,
      pdfUrl: `https://arxiv.org/pdf/${fallbackPaperId}`,
    };
  }

  function comparePaperIdsLatestFirst(leftPaperId, rightPaperId) {
    return rightPaperId.localeCompare(leftPaperId, undefined, { numeric: true, sensitivity: 'base' });
  }

  function normalizePaperId(rawPaperId) {
    return String(rawPaperId || '')
      .replace(/^https?:\/\/arxiv\.org\/abs\//, '')
      .replace(/[?#].*$/, '')
      .replace(/v\d+$/, '')
      .trim();
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

  function wait(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }

  window.PinderScraper = {
    DEFAULT_LIST_URL,
    describeListUrl,
    getPreviousListUrl,
    fetchPaperList,
    ensurePaperLoaded,
    prefetchPapers,
  };
})();
