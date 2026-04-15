(() => {
  const DEFAULT_LIST_URL = buildDefaultListUrl();
  const REQUEST_TIMEOUT_MS = 30000;
  const PAPER_CACHE = new Map();
  const OPENALEX_WORK_CACHE = new Map();
  let NEXT_OPENALEX_REQUEST_AT = 0;
  const EARLIEST_ARXIV_YEAR = 1991;
  const JSON_SOURCE_PATH_RE = /\.json$/i;
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

  async function fetchPaperList({ listUrl = DEFAULT_LIST_URL, allowEmpty = false, trackKey = '', onProgress = () => {} } = {}) {
    if (isJsonSourceUrl(listUrl)) {
      onProgress('Loading paper list…');
      const payload = await fetchJsonSource(listUrl, { trackKey });

      if (!payload.papers.length && !allowEmpty) {
        throw new Error('Could not parse any papers from the JSON source.');
      }

      return payload;
    }

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
      paper.title = paper.title || String(paper.id || 'Paper');
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

  async function fetchJsonSource(sourceUrl, { trackKey = '' } = {}) {
    const text = await fetchSourceText(sourceUrl);

    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error('Could not parse the JSON paper source.');
    }

    const rawPapers = Array.isArray(payload) ? payload : payload?.papers;
    if (Array.isArray(rawPapers)) {
      return {
        sourceUrl: Array.isArray(payload) ? sourceUrl : (cleanUrl(payload.sourceUrl) || sourceUrl),
        sourceLabel: Array.isArray(payload) ? '' : cleanText(payload.sourceLabel || payload.title || ''),
        papers: rawPapers
          .map((paper, index) => normalizeJsonPaper(paper, index))
          .filter(Boolean),
      };
    }

    if (Array.isArray(payload?.tracks)) {
      const tracks = payload.tracks;
      const selectedTrack = selectJsonTrackCollection(payload, trackKey);
      if (!selectedTrack) {
        throw new Error('Could not find the requested track in the JSON paper source.');
      }

      const trackPapers = Array.isArray(selectedTrack.papers) ? selectedTrack.papers : [];
      const trackOptions = tracks
        .map((track, index) => buildJsonTrackOption(track, index))
        .filter(Boolean);

      return {
        sourceUrl: cleanUrl(sourceUrl),
        sourceLabel: cleanText(selectedTrack.sourceLabel || payload.sourceLabel || payload.title || ''),
        selectedTrackKey: cleanText(buildJsonTrackOption(selectedTrack)?.key || ''),
        trackOptions,
        papers: trackPapers
          .map((paper, index) => normalizeJsonPaper(paper, index))
          .filter(Boolean),
      };
    }

    throw new Error('The JSON paper source must be an array, an object with a papers array, or an object with a tracks array.');
  }

  async function fetchSourceText(sourceUrl) {
    const resolvedUrl = new URL(sourceUrl, window.location.href);

    if (resolvedUrl.origin === window.location.origin) {
      return fetchText(resolvedUrl.href);
    }

    try {
      return await fetchText(resolvedUrl.href);
    } catch (error) {
      return fetchThroughProxy(resolvedUrl.href);
    }
  }

  function selectJsonTrackCollection(payload, trackKey = '') {
    const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
    if (!tracks.length) {
      return null;
    }

    const normalizedTrackKey = cleanText(trackKey || '');
    if (!normalizedTrackKey) {
      const defaultTrackKey = cleanText(payload.defaultTrack || '');
      if (!defaultTrackKey) {
        return tracks[0];
      }

      return tracks.find((track) => matchesJsonTrack(track, defaultTrackKey)) || tracks[0];
    }

    return tracks.find((track) => matchesJsonTrack(track, normalizedTrackKey)) || null;
  }

  function matchesJsonTrack(track, trackKey) {
    const normalizedTrackKey = cleanText(trackKey || '');
    if (!normalizedTrackKey || !track || typeof track !== 'object') {
      return false;
    }

    return [
      cleanText(track.slug || ''),
      cleanText(track.sourceLabel || ''),
      cleanText(track.trackUrl || ''),
      cleanText(track.sourceUrl || ''),
      String(track.year || '').trim(),
    ].includes(normalizedTrackKey);
  }

  function buildJsonTrackOption(track, index = 0) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    const year = String(track.year || '').trim();
    const key = cleanText(track.slug || year || `track-${index + 1}`);
    if (!key) {
      return null;
    }

    return {
      key,
      year,
      label: cleanText(track.sourceLabel || `Track ${index + 1}`),
    };
  }

  function normalizeJsonPaper(paper, index) {
    if (!paper || typeof paper !== 'object') {
      return null;
    }

    const title = cleanText(paper.title || '');
    const id = cleanText(paper.id || title || paper.absUrl || paper.pdfUrl || paper.detailsUrl || `paper-${index + 1}`);
    if (!id) {
      return null;
    }

    const authors = Array.isArray(paper.authors)
      ? paper.authors.map((author) => cleanText(author)).filter(Boolean)
      : extractAuthorsFromText(paper.authorsText);
    const authorsText = cleanText(paper.authorsText || authors.join(', '));
    const abstract = cleanText(paper.abstract || '');
    const absUrl = cleanUrl(paper.absUrl || paper.detailsUrl || paper.url || '');
    const pdfUrl = normalizePdfUrl(paper.pdfUrl || paper.preprintUrl || '');

    return {
      ...paper,
      id,
      title: title || cleanText(paper.id || `Paper ${index + 1}`),
      authors,
      authorsText,
      abstract,
      absUrl,
      pdfUrl,
      loaded: paper.loaded === undefined ? Boolean(abstract) : Boolean(paper.loaded || abstract),
      loading: false,
      error: cleanText(paper.error || ''),
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

  async function fetchJson(url, options = {}, attempt = 1) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      await throttleOpenAlexRequest(url);

      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} while fetching ${url}`);
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      const status = Number(error?.status || 0);
      const maxAttempts = status === 429 ? 6 : 3;
      if (attempt >= maxAttempts) {
        throw error;
      }

      await wait(status === 429 ? attempt * 3000 : attempt * 700);
      return fetchJson(url, options, attempt + 1);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function throttleOpenAlexRequest(url) {
    if (!/^https:\/\/api\.openalex\.org\//i.test(cleanUrl(url))) {
      return;
    }

    const now = Date.now();
    const waitMilliseconds = Math.max(0, NEXT_OPENALEX_REQUEST_AT - now);
    NEXT_OPENALEX_REQUEST_AT = Math.max(NEXT_OPENALEX_REQUEST_AT, now) + 400;
    if (waitMilliseconds > 0) {
      await wait(waitMilliseconds);
    }
  }

  async function scrapeCurrentResearchrTrack({
    sourceUrl = window.location.href,
    sourceLabel = '',
    concurrency = 8,
    onProgress = () => {},
  } = {}) {
    const papers = parseResearchrAcceptedPapers(document, sourceUrl);
    if (!papers.length) {
      throw new Error('Could not find any accepted papers in #event-overview.');
    }

    const modalLoader = parseResearchrModalLoader(document);
    const results = new Array(papers.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (nextIndex < papers.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const paper = papers[currentIndex];

        try {
          const modalHtml = await fetchResearchrPaperModalHtml(paper.id, modalLoader);
          const modalData = parseResearchrPaperModal(modalHtml, paper);
          results[currentIndex] = {
            ...paper,
            ...modalData,
            loaded: true,
            loading: false,
            error: '',
          };
        } catch (error) {
          results[currentIndex] = {
            ...paper,
            absUrl: paper.absUrl || `${cleanUrl(sourceUrl)}#${paper.id}`,
            loaded: true,
            loading: false,
            error: error?.message || 'Could not load paper details.',
          };
        }

        completed += 1;
        onProgress(`[${completed}/${papers.length}] ${results[currentIndex].title}`);
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, papers.length)) }, () => worker()));

    return {
      sourceUrl: cleanUrl(sourceUrl || window.location.href),
      sourceLabel: cleanText(sourceLabel || inferResearchrSourceLabel(document)),
      collectedAt: new Date().toISOString(),
      paperCount: results.filter(Boolean).length,
      papers: results.filter(Boolean),
    };
  }

  function parseResearchrAcceptedPapers(trackDocument, sourceUrl = window.location.href) {
    const rows = Array.from(trackDocument.querySelectorAll('#event-overview table tr')).slice(1);

    return rows
      .map((row, index) => {
        const cell = row.querySelector('td:nth-child(2)') || row.cells?.[1] || row;
        const titleLink = cell?.querySelector('a[data-event-modal]');
        const title = getDirectTextContent(titleLink);
        const eventId = cleanText(titleLink?.getAttribute('data-event-modal') || '');

        if (!eventId || !title) {
          return null;
        }

        const authors = Array.from(cell.querySelectorAll('.performers a'))
          .map((authorLink) => cleanText(authorLink.textContent))
          .filter(Boolean);
        const authorsText = authors.join(', ');
        const publicationLinks = extractPublicationLinks(cell);
        const detailsUrl = cleanUrl(cell.querySelector('a[href*="/details/"]')?.href || '');
        const doiUrl = cleanUrl(publicationLinks.find((link) => /doi/i.test(link.label))?.href || '');
        const pdfUrl = normalizePdfUrl(publicationLinks.find((link) => /pre-print/i.test(link.label))?.href || '');

        return {
          order: index + 1,
          id: eventId,
          title,
          authors,
          authorsText,
          abstract: '',
          absUrl: detailsUrl || `${cleanUrl(sourceUrl)}#${eventId}`,
          pdfUrl,
          doiUrl,
          publicationLinks,
          trackUrl: cleanUrl(sourceUrl),
          detailsUrl,
          loaded: false,
          loading: false,
          error: '',
        };
      })
      .filter(Boolean);
  }

  function parseResearchrModalLoader(trackDocument) {
    const form = trackDocument.querySelector('#event-modal-loader form');
    if (!form) {
      throw new Error('Could not find the Researchr modal loader form.');
    }

    const eventInputName = cleanText(form.querySelector('.event-id-input')?.getAttribute('name') || '');
    const submitId = cleanText(form.querySelector('#load-modal-action')?.getAttribute('submitid') || '');
    if (!eventInputName || !submitId) {
      throw new Error('Could not parse the Researchr modal loader fields.');
    }

    return {
      action: cleanUrl(form.action || form.getAttribute('action') || window.location.href),
      eventInputName,
      submitId,
      contextValue: cleanText(form.querySelector('input[name="context"]')?.value || ''),
      staticFields: Array.from(form.querySelectorAll('input[type="hidden"]'))
        .map((input) => [cleanText(input.name), input.value])
        .filter(([name]) => Boolean(name)),
    };
  }

  async function fetchResearchrPaperModalHtml(eventId, modalLoader) {
    const formData = new FormData();
    modalLoader.staticFields.forEach(([name, value]) => {
      formData.append(name, value);
    });
    formData.append(modalLoader.eventInputName, eventId);
    if (modalLoader.contextValue) {
      formData.append('context', modalLoader.contextValue);
    }
    formData.append(modalLoader.submitId, '1');
    formData.append('__ajax_runtime_request__', 'event-modal-loader');

    const operations = await fetchJson(modalLoader.action, {
      method: 'POST',
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: formData,
    });

    const modalHtml = Array.isArray(operations)
      ? operations.find((operation) => operation?.action === 'append' && operation?.id === 'event-modals')?.value
      : '';

    if (!modalHtml) {
      throw new Error(`Could not fetch Researchr details for ${eventId}.`);
    }

    return modalHtml;
  }

  function parseResearchrPaperModal(modalHtml, paper = {}) {
    const modalDocument = new DOMParser().parseFromString(modalHtml, 'text/html');
    const modalRoot = modalDocument.querySelector('.modal') || modalDocument.body || modalDocument;
    const eventDescription = modalRoot.querySelector('.event-description');
    const abstractParagraphs = Array.from(eventDescription?.children || [])
      .filter((element) => element?.tagName === 'P')
      .map((element) => cleanText(element.textContent))
      .filter(Boolean);
    const publicationLinks = mergePublicationLinks(paper.publicationLinks, extractPublicationLinks(eventDescription || modalRoot));
    const detailsUrl = cleanUrl(modalRoot.querySelector('a[href*="/details/"]')?.href || paper.detailsUrl || '');
    const doiUrl = cleanUrl(publicationLinks.find((link) => /doi/i.test(link.label))?.href || paper.doiUrl || '');
    const pdfUrl = normalizePdfUrl(publicationLinks.find((link) => /pre-print/i.test(link.label))?.href || paper.pdfUrl || '');

    return {
      title: cleanText(modalRoot.querySelector('.event-title strong')?.textContent || paper.title || ''),
      abstract: abstractParagraphs.join('\n\n'),
      absUrl: detailsUrl || paper.absUrl || `${cleanUrl(paper.trackUrl)}#${paper.id}`,
      pdfUrl,
      doiUrl,
      detailsUrl,
      publicationLinks,
      scheduleText: cleanText(modalRoot.querySelector('.modal-header strong')?.textContent || ''),
      sessionText: cleanText(Array.from(modalRoot.querySelectorAll('.modal-header a'))
        .map((anchor) => anchor.textContent)
        .join(' ')),
    };
  }

  function inferResearchrSourceLabel(trackDocument) {
    const rawTitle = cleanText(trackDocument?.title || '');
    const cleanedTitle = rawTitle.replace(/^\*+\s*|\s*\*+$/g, '');
    const segments = cleanedTitle.split(/\s+-\s+/).map((segment) => cleanText(segment.replace(/^\*+\s*|\s*\*+$/g, ''))).filter(Boolean);

    if (segments.length >= 2) {
      return `${segments[0]} ${segments[1]}`;
    }

    return cleanedTitle || 'Researchr track';
  }

  function getDirectTextContent(element) {
    if (!element) {
      return '';
    }

    return cleanText(Array.from(element.childNodes)
      .filter((node) => node?.nodeType === 3)
      .map((node) => node.textContent)
      .join(' '));
  }

  function extractPublicationLinks(rootElement) {
    if (!rootElement) {
      return [];
    }

    return Array.from(rootElement.querySelectorAll('a.publication-link'))
      .map((anchor) => ({
        label: cleanText(anchor.textContent),
        href: cleanUrl(anchor.href),
      }))
      .filter((link) => link.label && link.href);
  }

  function mergePublicationLinks(...linkGroups) {
    const mergedLinks = [];
    const seen = new Set();

    linkGroups.flat().forEach((link) => {
      if (!link?.href) {
        return;
      }

      const normalizedLink = {
        label: cleanText(link.label),
        href: cleanUrl(link.href),
      };
      const key = `${normalizedLink.label}::${normalizedLink.href}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      mergedLinks.push(normalizedLink);
    });

    return mergedLinks;
  }

  function extractLegacyAcmCitationId(url) {
    const match = cleanUrl(url).match(/[?&]id=([^&#]+)/i);
    return cleanText(match?.[1] || '');
  }

  function inferDblpLegacyAcmProceedingsId(trackDocument) {
    const citationLinks = Array.from(trackDocument.querySelectorAll('a[href*="citation.cfm?id="], a[href*="portal.acm.org/citation.cfm?id="]'));
    const firstNumericCitationId = citationLinks
      .map((anchor) => extractLegacyAcmCitationId(anchor.href))
      .find((citationId) => /^\d+$/.test(citationId));

    return cleanText(firstNumericCitationId || '');
  }

  function buildLegacyAcmDlUrl(legacyAcmCitationUrl, legacyAcmProceedingsId = '') {
    const citationId = extractLegacyAcmCitationId(legacyAcmCitationUrl);
    if (!citationId) {
      return '';
    }

    const normalizedRecordId = /^\d+\.\d+$/.test(citationId)
      ? citationId
      : (/^\d+$/.test(citationId) && /^\d+$/.test(legacyAcmProceedingsId)
        ? `${legacyAcmProceedingsId}.${citationId}`
        : '');

    return normalizedRecordId
      ? `https://dl.acm.org/doi/10.5555/${normalizedRecordId}`
      : '';
  }

  async function scrapeCurrentDblpConferencePage({
    sourceUrl = window.location.href,
    sourceLabel = '',
    sectionTitle = '',
    includeSectionTitlePrefixes = [],
    excludeSectionTitlePrefixes = [],
    minPageCount = 0,
    maxPageEnd = 0,
    publicationYear = 0,
    concurrency = 8,
    onProgress = () => {},
  } = {}) {
    const papers = parseDblpConferencePapers(document, {
      sourceUrl,
      sectionTitle,
      includeSectionTitlePrefixes,
      excludeSectionTitlePrefixes,
      minPageCount,
      maxPageEnd,
      publicationYear,
    });
    if (!papers.length) {
      throw new Error('Could not find any papers on the DBLP conference page.');
    }

    const results = new Array(papers.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
      while (nextIndex < papers.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const paper = papers[currentIndex];

        try {
          const openAlexWork = await fetchOpenAlexWorkForPaper(paper, { publicationYear });
          const resolvedDoiUrl = cleanUrl(openAlexWork?.doi || paper.doiUrl || '');
          const abstract = buildAbstractFromInvertedIndex(openAlexWork?.abstract_inverted_index)
            || paper.abstract
            || 'No abstract available.';
          const openAccessPdfUrl = cleanUrl(
            openAlexWork?.best_oa_location?.pdf_url
              || openAlexWork?.primary_location?.pdf_url
              || '',
          );
          const openAccessLandingUrl = cleanUrl(
            openAlexWork?.best_oa_location?.landing_page_url
              || openAlexWork?.primary_location?.landing_page_url
              || '',
          );
          const publicationLinks = mergePublicationLinks(
            resolvedDoiUrl ? [{ label: 'DOI', href: resolvedDoiUrl }] : [],
            paper.publicationLinks,
            openAccessPdfUrl ? [{ label: 'Open access PDF', href: openAccessPdfUrl }] : [],
            openAccessLandingUrl ? [{ label: 'Open access landing page', href: openAccessLandingUrl }] : [],
          );

          results[currentIndex] = {
            ...paper,
            abstract,
            absUrl: openAccessLandingUrl || resolvedDoiUrl || paper.absUrl || `${cleanUrl(sourceUrl)}#${paper.id}`,
            pdfUrl: normalizePdfUrl(openAccessPdfUrl || paper.pdfUrl || ''),
            doiUrl: resolvedDoiUrl,
            publicationLinks,
            loaded: true,
            loading: false,
            error: '',
          };
        } catch (error) {
          results[currentIndex] = {
            ...paper,
            abstract: paper.abstract || 'No abstract available.',
            loaded: true,
            loading: false,
            error: '',
          };
        }

        completed += 1;
        onProgress(`[${completed}/${papers.length}] ${results[currentIndex].title}`);
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, papers.length)) }, () => worker()));

    return {
      sourceUrl: cleanUrl(sourceUrl || window.location.href),
      sourceLabel: cleanText(sourceLabel || inferDblpSourceLabel(document)),
      collectedAt: new Date().toISOString(),
      paperCount: results.filter(Boolean).length,
      papers: results.filter(Boolean),
    };
  }

  function parseDblpConferencePapers(
    trackDocument,
    {
      sourceUrl = window.location.href,
      sectionTitle = '',
      includeSectionTitlePrefixes = [],
      excludeSectionTitlePrefixes = [],
      minPageCount = 0,
      maxPageEnd = 0,
      publicationYear = 0,
    } = {},
  ) {
    const legacyAcmProceedingsId = inferDblpLegacyAcmProceedingsId(trackDocument);

    return getDblpConferenceEntryElements(trackDocument, {
      sectionTitle,
      includeSectionTitlePrefixes,
      excludeSectionTitlePrefixes,
    })
      .map((entryElement, index) => {
        const title = cleanText(entryElement.querySelector('.title')?.textContent || '').replace(/\.$/, '');
        const pageMetadata = parseDblpEntryPagination(entryElement);
        if (!matchesDblpPageFilters(pageMetadata, { minPageCount, maxPageEnd })) {
          return null;
        }

        const authors = Array.from(entryElement.querySelectorAll('span[itemprop="author"] span[itemprop="name"]'))
          .map((authorElement) => cleanText(authorElement.textContent))
          .filter(Boolean);
        const authorsText = authors.join(', ');
        const doiUrl = cleanUrl(entryElement.querySelector('nav.publ a[href^="https://doi.org/"]')?.href || '');
        const dblpUrl = cleanUrl(
          entryElement.querySelector('nav.publ a[href*="dblp.org/rec/"]')?.href
            || entryElement.querySelector('li.drop-down div.head a[href]')?.href
            || '',
        );
        const eeUrl = cleanUrl(entryElement.querySelector('nav.publ a[href]')?.href || '');
        const legacyAcmDlUrl = buildLegacyAcmDlUrl(eeUrl, legacyAcmProceedingsId);
        const publicationLinks = mergePublicationLinks(
          doiUrl ? [{ label: 'DOI', href: doiUrl }] : [],
          legacyAcmDlUrl ? [{ label: 'ACM DL', href: legacyAcmDlUrl }] : [],
          dblpUrl ? [{ label: 'DBLP', href: dblpUrl }] : [],
          eeUrl && eeUrl !== doiUrl && eeUrl !== dblpUrl && eeUrl !== legacyAcmDlUrl ? [{ label: 'Electronic edition', href: eeUrl }] : [],
        );
        const paperId = cleanText(stripDoiPrefix(doiUrl) || legacyAcmDlUrl || dblpUrl || title || `paper-${index + 1}`);

        if (!paperId || !title) {
          return null;
        }

        return {
          order: index + 1,
          id: paperId,
          title,
          authors,
          authorsText,
          abstract: '',
          absUrl: doiUrl || legacyAcmDlUrl || dblpUrl || eeUrl || `${cleanUrl(sourceUrl)}#${paperId}`,
          pdfUrl: '',
          doiUrl,
          acmDlUrl: legacyAcmDlUrl,
          publicationLinks,
          trackUrl: cleanUrl(sourceUrl),
          detailsUrl: dblpUrl,
          publicationYear: Number.isInteger(publicationYear) ? publicationYear : 0,
          loaded: false,
          loading: false,
          error: '',
        };
      })
      .filter(Boolean)
      .map((paper, index) => ({
        ...paper,
        order: index + 1,
      }));
  }

  function getDblpConferenceEntryElements(
    trackDocument,
    {
      sectionTitle = '',
      includeSectionTitlePrefixes = [],
      excludeSectionTitlePrefixes = [],
    } = {},
  ) {
    const sections = getDblpConferenceSections(trackDocument);
    if (!sections.length) {
      return Array.from(trackDocument.querySelectorAll('li.entry.inproceedings'));
    }

    const normalizedSectionTitle = normalizeComparisonText(sectionTitle);
    if (normalizedSectionTitle) {
      const matchingSection = sections
        .find((section) => normalizeComparisonText(section.title) === normalizedSectionTitle);
      return matchingSection ? matchingSection.entryElements : [];
    }

    const normalizedIncludedPrefixes = normalizeComparisonTextList(includeSectionTitlePrefixes);
    if (normalizedIncludedPrefixes.length) {
      return sections
        .filter((section) => matchesDblpSectionPrefix(section.title, normalizedIncludedPrefixes))
        .flatMap((section) => section.entryElements);
    }

    const normalizedExcludedPrefixes = normalizeComparisonTextList(excludeSectionTitlePrefixes);
    if (!normalizedExcludedPrefixes.length) {
      return Array.from(trackDocument.querySelectorAll('li.entry.inproceedings'));
    }

    return sections
      .filter((section) => !matchesDblpSectionPrefix(section.title, normalizedExcludedPrefixes))
      .flatMap((section) => section.entryElements);
  }

  function getDblpConferenceSections(trackDocument) {
    return Array.from(trackDocument.querySelectorAll('header.h2'))
      .map((header) => {
        const entryElements = [];
        let currentNode = header.nextElementSibling;
        while (currentNode) {
          if (currentNode.matches?.('header.h2')) {
            break;
          }

          if (currentNode.matches?.('li.entry.inproceedings')) {
            entryElements.push(currentNode);
          }

          entryElements.push(...Array.from(currentNode.querySelectorAll?.('li.entry.inproceedings') || []));
          currentNode = currentNode.nextElementSibling;
        }

        return {
          title: cleanText(header.textContent || ''),
          entryElements,
        };
      })
      .filter((section) => section.entryElements.length);
  }

  function matchesDblpSectionPrefix(sectionTitle, normalizedPrefixes) {
    if (!normalizedPrefixes.length) {
      return false;
    }

    const normalizedSectionTitle = normalizeComparisonText(sectionTitle);
    return normalizedPrefixes.some((prefix) => normalizedSectionTitle.startsWith(prefix));
  }

  function parseDblpEntryPagination(entryElement) {
    return parseDblpPaginationText(cleanText(entryElement.querySelector('span[itemprop="pagination"]')?.textContent || ''));
  }

  function parseDblpPaginationText(paginationText) {
    const cleanedPaginationText = cleanText(paginationText);
    if (!cleanedPaginationText) {
      return {
        text: '',
        pageStart: null,
        pageEnd: null,
        pageCount: null,
      };
    }

    const pageNumbers = cleanedPaginationText.match(/\d+/g) || [];
    if (!pageNumbers.length) {
      return {
        text: cleanedPaginationText,
        pageStart: null,
        pageEnd: null,
        pageCount: null,
      };
    }

    if (pageNumbers.length === 1) {
      const pageNumber = Number(pageNumbers[0]);
      return {
        text: cleanedPaginationText,
        pageStart: Number.isFinite(pageNumber) ? pageNumber : null,
        pageEnd: Number.isFinite(pageNumber) ? pageNumber : null,
        pageCount: Number.isFinite(pageNumber) ? 1 : null,
      };
    }

    const pageStart = Number(pageNumbers[0]);
    const pageEnd = Number(pageNumbers[pageNumbers.length - 1]);
    const pageCount = Number.isFinite(pageStart) && Number.isFinite(pageEnd) && pageEnd >= pageStart
      ? (pageEnd - pageStart + 1)
      : null;

    return {
      text: cleanedPaginationText,
      pageStart: Number.isFinite(pageStart) ? pageStart : null,
      pageEnd: Number.isFinite(pageEnd) ? pageEnd : null,
      pageCount,
    };
  }

  function matchesDblpPageFilters(pageMetadata, { minPageCount = 0, maxPageEnd = 0 } = {}) {
    const normalizedMinPageCount = Number(minPageCount) || 0;
    if (normalizedMinPageCount > 0) {
      if (!Number.isInteger(pageMetadata?.pageCount) || pageMetadata.pageCount < normalizedMinPageCount) {
        return false;
      }
    }

    const normalizedMaxPageEnd = Number(maxPageEnd) || 0;
    if (normalizedMaxPageEnd > 0) {
      if (!Number.isInteger(pageMetadata?.pageEnd) || pageMetadata.pageEnd > normalizedMaxPageEnd) {
        return false;
      }
    }

    return true;
  }

  function normalizeComparisonTextList(values) {
    return (Array.isArray(values) ? values : [values])
      .map((value) => normalizeComparisonText(value))
      .filter(Boolean);
  }

  function normalizeComparisonText(text) {
    return cleanText(text).toLowerCase();
  }

  async function fetchOpenAlexWorkForPaper(paper, { publicationYear = 0 } = {}) {
    const resolvedPublicationYear = Number.isInteger(publicationYear) && publicationYear > 0
      ? publicationYear
      : (Number.isInteger(paper?.publicationYear) ? paper.publicationYear : 0);
    const workByDoi = await fetchOpenAlexWorkByDoi(paper?.doiUrl || '');
    const workByTitle = await fetchOpenAlexWorkByTitle(paper?.title || '', {
      publicationYear: resolvedPublicationYear,
      allowBroadYearMatch: true,
    });

    if (!workByDoi) {
      return workByTitle;
    }

    if (hasOpenAlexAbstract(workByTitle) && !hasOpenAlexAbstract(workByDoi)) {
      return workByTitle;
    }

    return workByDoi || workByTitle;
  }

  async function fetchOpenAlexWorkByDoi(doiUrlOrDoi) {
    const doi = stripDoiPrefix(doiUrlOrDoi);
    if (!doi) {
      return null;
    }

    const cacheKey = `doi:${doi.toLowerCase()}`;
    if (OPENALEX_WORK_CACHE.has(cacheKey)) {
      return OPENALEX_WORK_CACHE.get(cacheKey);
    }

    const workPromise = (async () => {
      const payload = await fetchJson(`https://api.openalex.org/works?filter=doi:${encodeURIComponent(doi)}`);
      return Array.isArray(payload?.results) ? (payload.results[0] || null) : null;
    })();

    OPENALEX_WORK_CACHE.set(cacheKey, workPromise);

    try {
      return await workPromise;
    } catch (error) {
      OPENALEX_WORK_CACHE.delete(cacheKey);
      throw error;
    }
  }

  async function fetchOpenAlexWorkByTitle(title, { publicationYear = 0, allowBroadYearMatch = false } = {}) {
    const normalizedTitle = normalizeTitleForComparison(title);
    if (!normalizedTitle) {
      return null;
    }

    const normalizedYear = Number.isInteger(publicationYear) && publicationYear > 0
      ? publicationYear
      : 0;
    const cacheKey = `title:${normalizedYear}:${allowBroadYearMatch ? 'broad' : 'strict'}:${normalizedTitle}`;
    if (OPENALEX_WORK_CACHE.has(cacheKey)) {
      return OPENALEX_WORK_CACHE.get(cacheKey);
    }

    const workPromise = (async () => {
      const queryAttempts = [];
      if (normalizedYear) {
        queryAttempts.push({
          yearFilter: normalizedYear,
        });
      }
      if (!normalizedYear || allowBroadYearMatch) {
        queryAttempts.push({
          yearFilter: 0,
        });
      }

      for (const queryAttempt of queryAttempts) {
        const queryUrl = new URL('https://api.openalex.org/works');
        queryUrl.searchParams.set('search', title);
        queryUrl.searchParams.set('per-page', '10');
        if (queryAttempt.yearFilter) {
          queryUrl.searchParams.set('filter', `publication_year:${queryAttempt.yearFilter}`);
        }

        const payload = await fetchJson(queryUrl.href);
        const results = Array.isArray(payload?.results) ? payload.results : [];
        const matchedWork = selectBestOpenAlexTitleMatch(results, title);
        if (matchedWork) {
          return matchedWork;
        }
      }

      return null;
    })();

    OPENALEX_WORK_CACHE.set(cacheKey, workPromise);

    try {
      return await workPromise;
    } catch (error) {
      OPENALEX_WORK_CACHE.delete(cacheKey);
      throw error;
    }
  }

  function selectBestOpenAlexTitleMatch(results, title) {
    const exactMatch = results.find((result) => titlesLikelyMatch(result?.display_name || '', title));
    if (exactMatch) {
      return exactMatch;
    }

    const rankedCandidates = results
      .map((result) => ({
        result,
        score: scoreTitleSimilarity(result?.display_name || '', title),
      }))
      .sort((left, right) => right.score.overlap - left.score.overlap || right.score.jaccard - left.score.jaccard);
    const bestCandidate = rankedCandidates[0];
    if (!bestCandidate) {
      return null;
    }

    if (bestCandidate.score.sharedTokenCount >= 4 && (bestCandidate.score.overlap >= 0.75 || bestCandidate.score.jaccard >= 0.6)) {
      return bestCandidate.result;
    }

    return null;
  }

  function hasOpenAlexAbstract(work) {
    return Boolean(work?.abstract_inverted_index && typeof work.abstract_inverted_index === 'object' && Object.keys(work.abstract_inverted_index).length);
  }

  function buildAbstractFromInvertedIndex(abstractInvertedIndex) {
    if (!abstractInvertedIndex || typeof abstractInvertedIndex !== 'object') {
      return '';
    }

    const positions = [];
    Object.entries(abstractInvertedIndex).forEach(([word, indexes]) => {
      indexes.forEach((index) => {
        positions[index] = word;
      });
    });

    return cleanText(positions.join(' '));
  }

  function stripDoiPrefix(doiUrlOrDoi) {
    return cleanText(String(doiUrlOrDoi || '').replace(/^https?:\/\/doi\.org\//i, ''));
  }

  function titlesLikelyMatch(leftTitle, rightTitle) {
    const leftVariants = buildComparableTitleVariants(leftTitle);
    const rightVariants = buildComparableTitleVariants(rightTitle);
    if (!leftVariants.length || !rightVariants.length) {
      return false;
    }

    return leftVariants.some((leftVariant) => rightVariants.some((rightVariant) => {
      if (leftVariant === rightVariant) {
        return true;
      }

      const minLength = Math.min(leftVariant.length, rightVariant.length);
      if (minLength < 18) {
        return false;
      }

      return leftVariant.startsWith(rightVariant) || rightVariant.startsWith(leftVariant);
    }));
  }

  function buildComparableTitleVariants(title) {
    const baseTitle = cleanText(title).replace(/\.$/, '');
    const variants = new Set();

    [
      baseTitle,
      baseTitle.replace(/\((?:abstract(?: only)?|extended abstract|tutorial|panel|experience report|status report)\)/ig, ''),
      baseTitle.replace(/\b(?:abstract(?: only)?|extended abstract|tutorial|panel|experience report|status report)\b/ig, ''),
      baseTitle.replace(/\([^)]*\)/g, ''),
    ].forEach((value) => {
      const normalizedValue = normalizeTitleForComparison(value);
      if (normalizedValue) {
        variants.add(normalizedValue);
      }
    });

    return Array.from(variants);
  }

  function scoreTitleSimilarity(leftTitle, rightTitle) {
    const leftTokens = new Set(normalizeTitleForComparison(leftTitle).split(' ').filter(Boolean));
    const rightTokens = new Set(normalizeTitleForComparison(rightTitle).split(' ').filter(Boolean));
    if (!leftTokens.size || !rightTokens.size) {
      return {
        overlap: 0,
        jaccard: 0,
        sharedTokenCount: 0,
      };
    }

    let sharedTokenCount = 0;
    leftTokens.forEach((token) => {
      if (rightTokens.has(token)) {
        sharedTokenCount += 1;
      }
    });

    const unionCount = new Set([...leftTokens, ...rightTokens]).size;
    return {
      overlap: sharedTokenCount / Math.min(leftTokens.size, rightTokens.size),
      jaccard: unionCount ? (sharedTokenCount / unionCount) : 0,
      sharedTokenCount,
    };
  }

  function normalizeTitleForComparison(title) {
    return cleanText(title)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function inferDblpSourceLabel(trackDocument) {
    return cleanText(String(trackDocument?.title || '').replace(/^dblp:\s*/i, '')) || 'DBLP conference page';
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

  function isJsonSourceUrl(sourceUrl) {
    if (!sourceUrl) {
      return false;
    }

    try {
      const parsedUrl = new URL(sourceUrl, window.location.href);
      return JSON_SOURCE_PATH_RE.test(parsedUrl.pathname);
    } catch (error) {
      return JSON_SOURCE_PATH_RE.test(String(sourceUrl || ''));
    }
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

  function extractAuthorsFromText(authorsText) {
    const normalizedText = cleanText(authorsText || '');
    return normalizedText
      ? normalizedText.split(/\s*,\s*/).map((author) => cleanText(author)).filter(Boolean)
      : [];
  }

  function cleanUrl(url) {
    return String(url || '').trim();
  }

  function normalizePdfUrl(url) {
    return cleanUrl(url).replace(/^https?:\/\/arxiv\.org\/abs\//i, 'https://arxiv.org/pdf/');
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
    scrapeCurrentResearchrTrack,
    scrapeCurrentDblpConferencePage,
  };
})();
