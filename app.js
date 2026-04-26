const DECISIONS = {
  reject: {
    key: 'reject',
    label: 'Reject',
    shortLabel: '↓ Reject',
    className: 'reject',
    vector: { x: 0, y: 1 },
  },
  weakReject: {
    key: 'weakReject',
    label: 'Weak reject',
    shortLabel: '← Weak reject',
    className: 'weak-reject',
    vector: { x: -1, y: 0 },
  },
  weakAccept: {
    key: 'weakAccept',
    label: 'Weak accept',
    shortLabel: '→ Weak accept',
    className: 'weak-accept',
    vector: { x: 1, y: 0 },
  },
  accept: {
    key: 'accept',
    label: 'Accept',
    shortLabel: '↑ Accept',
    className: 'accept',
    vector: { x: 0, y: -1 },
  },
};

const STORAGE_KEY = 'pinder-decisions-v1';
const SETTINGS_STORAGE_KEY = 'pinder-settings-v1';
const LAST_ARXIV_SOURCE_STORAGE_KEY = 'pinder-last-arxiv-source-v1';
const LAST_ICSE_TRACK_STORAGE_KEY = 'pinder-last-icse-track-v1';
const ICSE_COLLECTION_SOURCE = 'data/icse.json';

const PAPER_DETAILS_PREFETCH_COUNT = 4;
const OLDER_MONTH_PREFETCH_TRIGGER_REMAINING = 24;
const OLDER_MONTH_APPEND_TRIGGER_REMAINING = 10;
const CARD_TAP_DISTANCE_THRESHOLD = 10;

const state = {
  sourceUrl: '',
  sourceLabel: '',
  trackOptions: [],
  selectedTrackKey: '',
  papers: [],
  decisions: loadDecisions(),
  settings: loadSettings(),
  settingsOpen: false,
  sourceMenuOpen: false,
  abstractModalOpen: false,
  abstractModalPaper: null,
  undoStack: [],
  drag: null,
  animating: false,
  statusTimer: null,
  decisionSyncTimer: null,
  loadedSourceUrls: [],
  loadedPaperIds: new Set(),
  feedArchive: '',
  newestLoadedPeriod: '',
  oldestLoadedPeriod: '',
  nextOlderSourceUrl: '',
  prefetchedOlderBatch: null,
  olderMonthPromise: null,
  olderMonthLoading: false,
  olderMonthExhausted: false,
  olderMonthError: '',
  icseVisualizationTracks: [],
  icseVisualizationPaperByKey: new Map(),
  icseVisualizationStructureKey: '',
  icseVisualizationHoveredPaperKey: '',
  uncheckedAuthors: new Set(),
  authorFilterOpen: false,
  searchQuery: '',
  viewMode: 'swipe',
};

const elements = {
  statusPanel: document.getElementById('statusPanel'),
  sourceSwitcherButton: document.getElementById('sourceSwitcherButton'),
  sourceLabel: document.getElementById('sourceLabel'),
  sourceMenu: document.getElementById('sourceMenu'),
  sourceArxivOption: document.getElementById('sourceArxivOption'),
  sourceIcseOption: document.getElementById('sourceIcseOption'),
  topbarBrand: document.getElementById('topbarBrand'),
  trackPickerWrap: document.getElementById('trackPickerWrap'),
  trackPicker: document.getElementById('trackPicker'),
  filterButton: document.getElementById('filterButton'),
  searchInput: document.getElementById('searchInput'),
  searchClearButton: document.getElementById('searchClearButton'),
  filterMenu: document.getElementById('filterMenu'),
  authorSearchInput: document.getElementById('authorSearchInput'),
  selectAllAuthorsButton: document.getElementById('selectAllAuthorsButton'),
  clearAllAuthorsButton: document.getElementById('clearAllAuthorsButton'),
  authorList: document.getElementById('authorList'),
  modeToggleButton: document.getElementById('modeToggleButton'),
  topAuthButton: document.getElementById('topAuthButton'),
  settingsButton: document.getElementById('settingsButton'),
  settingsMenu: document.getElementById('settingsMenu'),
  showButtonsToggle: document.getElementById('showButtonsToggle'),
  showTitleToggle: document.getElementById('showTitleToggle'),
  showAuthorsToggle: document.getElementById('showAuthorsToggle'),
  authStatus: document.getElementById('authStatus'),
  syncStatus: document.getElementById('syncStatus'),
  progressPanel: document.getElementById('progressPanel'),
  progressFill: document.getElementById('progressFill'),
  cardStack: document.getElementById('cardStack'),
  currentCard: document.getElementById('currentCard'),
  paperCardContent: document.getElementById('paperCardContent'),
  nextCard: document.getElementById('nextCard'),
  decisionBadge: document.getElementById('decisionBadge'),
  paperId: document.getElementById('paperId'),
  absLink: document.getElementById('absLink'),
  pdfLink: document.getElementById('pdfLink'),
  paperTitle: document.getElementById('paperTitle'),
  authorsSection: document.getElementById('authorsSection'),
  paperAuthors: document.getElementById('paperAuthors'),
  paperAbstract: document.getElementById('paperAbstract'),
  abstractModal: document.getElementById('abstractModal'),
  abstractModalBackdrop: document.getElementById('abstractModalBackdrop'),
  abstractModalSheet: document.getElementById('abstractModalSheet'),
  abstractModalBody: document.getElementById('abstractModalBody'),
  abstractModalHint: document.getElementById('abstractModalHint'),
  abstractModalTitle: document.getElementById('abstractModalTitle'),
  abstractModalText: document.getElementById('abstractModalText'),
  nextTitle: document.getElementById('nextTitle'),
  nextAuthors: document.getElementById('nextAuthors'),
  emptyState: document.getElementById('emptyState'),
  emptySummary: document.getElementById('emptySummary'),
  summaryGrid: document.getElementById('summaryGrid'),
  stats: document.getElementById('stats'),
  icseVisualization: document.getElementById('icseVisualization'),
  icseVisualizationSummary: document.getElementById('icseVisualizationSummary'),
  icseVisualizationLegend: document.getElementById('icseVisualizationLegend'),
  icseVisualizationHover: document.getElementById('icseVisualizationHover'),
  icsePaperMap: document.getElementById('icsePaperMap'),
  icseVisualizationTooltip: document.getElementById('icseVisualizationTooltip'),
  undoButton: document.getElementById('undoButton'),
  exportButton: document.getElementById('exportButton'),
  actionGrid: document.getElementById('actionGrid'),
  actionButtons: Array.from(document.querySelectorAll('.action-button')),
};

async function init() {
  const missingRequirements = getMissingDomRequirements();
  if (missingRequirements.length) {
    const message = `Pinder assets are out of sync. This usually means GitHub Pages or your browser cached an older app.js or index.html. Hard refresh the page and try again. Missing: ${missingRequirements.join(', ')}`;
    console.error(message);
    document.body.innerHTML = `<main class="app-shell"><div class="status-panel">${message}</div></main>`;
    return;
  }

  if (!auth) {
    const message = 'Could not load auth.js. Hard refresh the page and try again.';
    console.error(message);
    document.body.innerHTML = `<main class="app-shell"><div class="status-panel">${message}</div></main>`;
    return;
  }

  if (!window.PinderScraper) {
    const message = 'Could not load scrape.js. Hard refresh the page and try again.';
    console.error(message);
    document.body.innerHTML = `<main class="app-shell"><div class="status-panel">${message}</div></main>`;
    return;
  }

  applySettings();
  bindEvents();
  auth.initialize();
  showStatus('Fetching papers…');

  try {
    const sourceUrl = getSourceUrlFromQuery();
    const sourceTrack = getSourceTrackFromQuery();
    const payload = await window.PinderScraper.fetchPaperList({
      listUrl: sourceUrl,
      trackKey: sourceTrack,
      onProgress: (message) => showStatus(message),
    });

    const resolvedSourceUrl = payload.sourceUrl || sourceUrl;
    initializeFeedState(resolvedSourceUrl, payload.sourceLabel || '', {
      trackOptions: payload.trackOptions || [],
      selectedTrackKey: payload.selectedTrackKey || '',
      icseVisualizationTracks: payload.icseVisualizationTracks || [],
    });
    appendPaperBatch(resolvedSourceUrl, payload.papers || []);


    if (!state.papers.length) {
      throw new Error('No papers were found in the selected source.');
    }

    await prefetchVisiblePapers();
    render();
    hideStatus();
    ensureOlderPaperSupplySoon();
  } catch (error) {
    console.error(error);
    showStatus(
      'Could not fetch papers in the browser. Hard refresh and try again. If the problem persists, the selected source or a public CORS proxy may be temporarily unavailable.',
      true,
    );
    elements.progressFill.style.width = '0%';
    elements.currentCard.classList.add('hidden');
    elements.nextCard.classList.add('hidden');
  }
}

function getSourceUrlFromQuery() {
  const requestedSourceUrl = new URLSearchParams(window.location.search).get('source');
  return requestedSourceUrl || window.PinderScraper.DEFAULT_LIST_URL;
}

function getSourceTrackFromQuery() {
  return new URLSearchParams(window.location.search).get('track') || '';
}


function initializeFeedState(sourceUrl, sourceLabel = '', {
  trackOptions = [],
  selectedTrackKey = '',
  icseVisualizationTracks = [],
} = {}) {
  state.sourceUrl = sourceUrl;
  state.sourceLabel = sourceLabel;
  state.trackOptions = Array.isArray(trackOptions) ? trackOptions : [];
  state.selectedTrackKey = selectedTrackKey || '';
  state.icseVisualizationTracks = Array.isArray(icseVisualizationTracks) ? icseVisualizationTracks : [];
  state.icseVisualizationPaperByKey = new Map();
  state.icseVisualizationStructureKey = '';
  state.icseVisualizationHoveredPaperKey = '';
  state.uncheckedAuthors = new Set();
  state.papers = [];
  state.loadedSourceUrls = [];
  state.loadedPaperIds = new Set();
  state.prefetchedOlderBatch = null;
  state.olderMonthPromise = null;
  state.olderMonthLoading = false;
  state.olderMonthError = '';
  state.abstractModalPaper = null;
  if (elements.authorSearchInput) {
    elements.authorSearchInput.value = '';
  }

  const sourceInfo = describeListUrl(sourceUrl);
  state.feedArchive = sourceInfo?.archive || '';
  state.newestLoadedPeriod = sourceInfo?.period || '';
  state.oldestLoadedPeriod = sourceInfo?.period || '';
  state.nextOlderSourceUrl = window.PinderScraper.getPreviousListUrl?.(sourceUrl) || '';
  state.olderMonthExhausted = !state.nextOlderSourceUrl;
  updateSourceLabel();
  updateSourceMenu();
  updateTrackPicker();
  rememberCurrentSourceSelection();
}

function describeListUrl(sourceUrl) {
  return window.PinderScraper.describeListUrl?.(sourceUrl) || null;
}

function appendPaperBatch(sourceUrl, papers) {
  if (!Array.isArray(papers) || !papers.length) {
    return 0;
  }

  const sourceInfo = describeListUrl(sourceUrl);
  const uniquePapers = papers
    .filter((paper) => paper?.id && !state.loadedPaperIds.has(paper.id))
    .map((paper) => ({
      ...paper,
      sourceUrl,
      sourcePeriod: sourceInfo?.period || '',
    }));

  uniquePapers.forEach((paper) => {
    state.loadedPaperIds.add(paper.id);
  });

  if (!uniquePapers.length) {
    return 0;
  }

  state.papers.push(...uniquePapers);

  if (!state.loadedSourceUrls.includes(sourceUrl)) {
    state.loadedSourceUrls.push(sourceUrl);
  }

  if (sourceInfo?.archive) {
    state.feedArchive = sourceInfo.archive;
  }

  if (sourceInfo?.period) {
    if (!state.newestLoadedPeriod) {
      state.newestLoadedPeriod = sourceInfo.period;
    }
    state.oldestLoadedPeriod = sourceInfo.period;
  }

  updateSourceLabel();
  return uniquePapers.length;
}

function updateSourceLabel() {
  elements.sourceLabel.textContent = formatSourceLabel();
  const isIcse = getCurrentSourceMode() === 'icse';
  elements.modeToggleButton.classList.toggle('hidden', !isIcse);
  if (!isIcse && state.viewMode === 'explore') {
    state.viewMode = 'swipe';
  }
}

function updateSourceMenu() {
  const currentSourceMode = getCurrentSourceMode();
  elements.sourceArxivOption.classList.toggle('active', currentSourceMode === 'arxiv');
  elements.sourceIcseOption.classList.toggle('active', currentSourceMode === 'icse');
}

function openSourceMenu() {
  closeSettingsMenu();
  closeFilterMenu();
  state.sourceMenuOpen = true;
  updateSourceMenu();
  elements.sourceMenu.classList.remove('hidden');
  elements.sourceSwitcherButton.setAttribute('aria-expanded', 'true');
}

function closeSourceMenu() {
  state.sourceMenuOpen = false;
  elements.sourceMenu.classList.add('hidden');
  elements.sourceSwitcherButton.setAttribute('aria-expanded', 'false');
}

function toggleSourceMenu() {
  if (state.sourceMenuOpen) {
    closeSourceMenu();
    return;
  }

  openSourceMenu();
}

function getCurrentSourceMode() {
  return isIcseCollectionSource(state.sourceUrl) ? 'icse' : 'arxiv';
}

function isIcseCollectionSource(sourceUrl) {
  if (!sourceUrl) {
    return false;
  }

  try {
    const parsedUrl = new URL(sourceUrl, window.location.href);
    return parsedUrl.pathname.endsWith('/icse.json') || parsedUrl.pathname === '/icse.json';
  } catch (error) {
    const normalizedSourceUrl = String(sourceUrl || '').trim();
    return normalizedSourceUrl === ICSE_COLLECTION_SOURCE || normalizedSourceUrl.endsWith('/icse.json');
  }
}

function saveLastSourcePreference(storageKey, value) {
  try {
    if (value) {
      window.localStorage.setItem(storageKey, value);
    }
  } catch (error) {
    console.warn('Could not save source preference.', error);
  }
}

function loadLastSourcePreference(storageKey) {
  try {
    return window.localStorage.getItem(storageKey) || '';
  } catch (error) {
    return '';
  }
}

function rememberCurrentSourceSelection() {
  if (getCurrentSourceMode() === 'icse') {
    saveLastSourcePreference(LAST_ICSE_TRACK_STORAGE_KEY, state.selectedTrackKey || '');
    return;
  }

  const sourceInfo = describeListUrl(state.sourceUrl);
  if (sourceInfo?.archive) {
    saveLastSourcePreference(LAST_ARXIV_SOURCE_STORAGE_KEY, state.sourceUrl);
  }
}

function switchSourceMode(nextSourceMode) {
  const currentSourceMode = getCurrentSourceMode();
  closeSourceMenu();

  if (nextSourceMode === currentSourceMode) {
    return;
  }

  const nextUrl = new URL(window.location.href);

  if (nextSourceMode === 'icse') {
    nextUrl.searchParams.set('source', ICSE_COLLECTION_SOURCE);
    const preferredTrackKey = state.selectedTrackKey || loadLastSourcePreference(LAST_ICSE_TRACK_STORAGE_KEY);
    if (preferredTrackKey) {
      nextUrl.searchParams.set('track', preferredTrackKey);
    } else {
      nextUrl.searchParams.delete('track');
    }
  } else {
    nextUrl.searchParams.set('source', loadLastSourcePreference(LAST_ARXIV_SOURCE_STORAGE_KEY) || window.PinderScraper.DEFAULT_LIST_URL);
    nextUrl.searchParams.delete('track');
  }

  showStatus(nextSourceMode === 'icse' ? 'Switching to ICSE…' : 'Switching to arXiv…');
  window.location.assign(nextUrl.toString());
}

function updateTrackPicker() {
  const trackOptions = Array.isArray(state.trackOptions) ? state.trackOptions : [];
  const showTrackPicker = trackOptions.length > 1;

  elements.trackPickerWrap.classList.toggle('hidden', !showTrackPicker);
  elements.trackPicker.disabled = !showTrackPicker;

  if (!showTrackPicker) {
    elements.trackPicker.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  trackOptions.forEach((trackOption) => {
    const optionElement = document.createElement('option');
    optionElement.value = String(trackOption.key || '');
    optionElement.textContent = formatTrackPickerOptionLabel(trackOption);
    fragment.appendChild(optionElement);
  });

  elements.trackPicker.replaceChildren(fragment);
  elements.trackPicker.value = state.selectedTrackKey || String(trackOptions[0]?.key || '');
}

function formatTrackPickerOptionLabel(trackOption = {}) {
  const rawLabel = String(trackOption.label || '').trim();
  const year = String(trackOption.year || '').trim();
  const suffix = rawLabel
    .replace(/^ICSE\s+\d{4}\s*/i, '')
    .replace(/^ICSE\s*/i, '')
    .trim();

  if (year && suffix) {
    return `${year} · ${suffix}`;
  }

  return rawLabel || year || String(trackOption.key || 'Track');
}

function onTrackPickerChange(event) {
  const nextTrackKey = String(event.target.value || '').trim();
  if (!nextTrackKey || nextTrackKey === state.selectedTrackKey) {
    return;
  }

  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set('source', getSourceUrlFromQuery());
  nextUrl.searchParams.set('track', nextTrackKey);
  showStatus('Switching ICSE track…');
  window.location.assign(nextUrl.toString());
}

async function loadPaperDetails(paper) {
  if (!paper) {
    return null;
  }

  return window.PinderScraper.ensurePaperLoaded(paper);
}

async function prefetchVisiblePapers() {
  const remainingPapers = getRemainingPapers();
  const visiblePapers = remainingPapers.slice(0, PAPER_DETAILS_PREFETCH_COUNT);

  await Promise.all(visiblePapers.map((paper) => loadPaperDetails(paper)));
}

function prefetchVisiblePapersSoon() {
  const remainingPapers = getRemainingPapers();
  const papersToPrefetch = remainingPapers
    .slice(0, PAPER_DETAILS_PREFETCH_COUNT)
    .filter((paper) => !paper.loaded && !paper.loading);

  if (!papersToPrefetch.length) {
    return;
  }

  window.PinderScraper
    .prefetchPapers(remainingPapers, {
      startIndex: 0,
      count: PAPER_DETAILS_PREFETCH_COUNT,
      concurrency: 2,
    })
    .then(() => {
      render();
    })
    .catch((error) => {
      console.warn('Could not prefetch paper details.', error);
    });
}

function canLoadOlderPapers() {
  return Boolean(state.prefetchedOlderBatch || state.olderMonthLoading || state.nextOlderSourceUrl);
}

function consumePrefetchedOlderBatch() {
  if (!state.prefetchedOlderBatch) {
    return 0;
  }

  const batch = state.prefetchedOlderBatch;
  state.prefetchedOlderBatch = null;
  return appendPaperBatch(batch.sourceUrl, batch.papers);
}

async function prefetchOlderMonth({ urgent = false } = {}) {
  if (state.prefetchedOlderBatch || state.olderMonthExhausted) {
    return state.prefetchedOlderBatch;
  }

  if (!state.nextOlderSourceUrl) {
    state.olderMonthExhausted = true;
    return null;
  }

  if (state.olderMonthPromise) {
    return state.olderMonthPromise;
  }

  state.olderMonthLoading = true;
  state.olderMonthError = '';

  state.olderMonthPromise = (async () => {
    let candidateUrl = state.nextOlderSourceUrl;

    while (candidateUrl) {
      const candidateInfo = describeListUrl(candidateUrl);

      if (urgent) {
        showStatus(
          candidateInfo?.period
            ? `Loading older papers from ${candidateInfo.period}…`
            : 'Loading older papers…',
        );
      }

      try {
        const payload = await window.PinderScraper.fetchPaperList({
          listUrl: candidateUrl,
          allowEmpty: true,
        });
        state.nextOlderSourceUrl = window.PinderScraper.getPreviousListUrl?.(candidateUrl) || '';
        if (!state.nextOlderSourceUrl) {
          state.olderMonthExhausted = true;
        }

        const freshPapers = (payload.papers || []).filter((paper) => !state.loadedPaperIds.has(paper.id));
        if (freshPapers.length) {
          state.prefetchedOlderBatch = {
            sourceUrl: candidateUrl,
            papers: freshPapers,
          };
          return state.prefetchedOlderBatch;
        }

        candidateUrl = state.nextOlderSourceUrl;
      } catch (error) {
        state.olderMonthError = error?.message || 'Could not load older papers.';
        if (!urgent) {
          console.warn(`Could not prefetch older papers from ${candidateUrl}.`, error);
          return null;
        }
        throw error;
      }
    }

    state.olderMonthExhausted = true;
    return null;
  })().finally(() => {
    state.olderMonthLoading = false;
    state.olderMonthPromise = null;
  });

  return state.olderMonthPromise;
}

async function ensureOlderPaperSupply({ urgent = false } = {}) {
  let appended = false;

  while (true) {
    let remainingCount = getRemainingPapers().length;

    if (state.prefetchedOlderBatch && (urgent || remainingCount <= OLDER_MONTH_APPEND_TRIGGER_REMAINING)) {
      appended = consumePrefetchedOlderBatch() > 0 || appended;
      remainingCount = getRemainingPapers().length;
    }

    if (
      !state.prefetchedOlderBatch
      && !state.olderMonthExhausted
      && state.nextOlderSourceUrl
      && (urgent || remainingCount <= OLDER_MONTH_PREFETCH_TRIGGER_REMAINING)
    ) {
      await prefetchOlderMonth({ urgent });

      if (state.prefetchedOlderBatch && (urgent || getRemainingPapers().length <= OLDER_MONTH_APPEND_TRIGGER_REMAINING)) {
        appended = consumePrefetchedOlderBatch() > 0 || appended;
      }
    }

    if (!urgent || getCurrentPaper() || state.olderMonthExhausted || !state.nextOlderSourceUrl) {
      break;
    }

    if (!state.prefetchedOlderBatch && !state.olderMonthLoading) {
      continue;
    }

    break;
  }

  if (!state.prefetchedOlderBatch && !state.olderMonthExhausted && state.nextOlderSourceUrl && !state.olderMonthLoading) {
    prefetchOlderMonth({ urgent: false }).catch((error) => {
      console.warn('Could not keep older paper prefetch warm.', error);
    });
  }

  return { appended };
}

function ensureOlderPaperSupplySoon() {
  ensureOlderPaperSupply({ urgent: false })
    .then((result) => {
      if (result?.appended) {
        render();
      }
    })
    .catch((error) => {
      console.warn('Could not prepare older papers.', error);
    });
}

function getMissingDomRequirements() {
  const requiredKeys = [
    'statusPanel',
    'sourceSwitcherButton',
    'sourceLabel',
    'sourceMenu',
    'sourceArxivOption',
    'sourceIcseOption',
    'topbarBrand',
    'trackPickerWrap',
    'trackPicker',
    'filterButton',
    'searchInput',
    'searchClearButton',
    'filterMenu',
    'authorSearchInput',
    'selectAllAuthorsButton',
    'clearAllAuthorsButton',
    'authorList',
    'modeToggleButton',
    'topAuthButton',
    'settingsButton',
    'settingsMenu',
    'showButtonsToggle',
    'showTitleToggle',
    'showAuthorsToggle',
    'authStatus',
    'syncStatus',
    'progressPanel',
    'progressFill',
    'cardStack',
    'currentCard',
    'paperCardContent',
    'nextCard',
    'decisionBadge',
    'paperId',
    'absLink',
    'pdfLink',
    'paperTitle',
    'authorsSection',
    'paperAuthors',
    'paperAbstract',
    'abstractModal',
    'abstractModalBackdrop',
    'abstractModalSheet',
    'abstractModalBody',
    'abstractModalHint',
    'abstractModalTitle',
    'abstractModalText',
    'nextTitle',
    'nextAuthors',
    'emptyState',
    'emptySummary',
    'summaryGrid',
    'stats',
    'icseVisualization',
    'icseVisualizationSummary',
    'icseVisualizationLegend',
    'icseVisualizationHover',
    'icsePaperMap',
    'icseVisualizationTooltip',
    'undoButton',
    'exportButton',
    'actionGrid',
  ];

  const missing = requiredKeys.filter((key) => !elements[key]);
  if (elements.actionButtons.length !== 4) {
    missing.push('actionButtons[4]');
  }

  return missing;
}

function normalizeSettings(rawSettings = {}) {
  return {
    showActionButtons: rawSettings.showActionButtons !== false,
    showTitleTagline: rawSettings.showTitleTagline !== false,
    showAuthors: rawSettings.showAuthors !== false,
    updatedAt: normalizeUpdatedAt(rawSettings.updatedAt),
  };
}

function normalizeUpdatedAt(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  return null;
}

function isRemoteSettingsNewer(remoteUpdatedAt, localUpdatedAt) {
  const remoteTime = Date.parse(remoteUpdatedAt || '');
  const localTime = Date.parse(localUpdatedAt || '');

  if (!Number.isFinite(remoteTime)) {
    return false;
  }

  if (!Number.isFinite(localTime)) {
    return true;
  }

  return remoteTime > localTime;
}

function extractArxivIdFromUrl(url) {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url, window.location.href);
    const match = parsed.pathname.match(/\/abs\/([^/?#]+)/);
    return match?.[1] || '';
  } catch (error) {
    const match = String(url).match(/\/abs\/([^/?#]+)/);
    return match?.[1] || '';
  }
}

function buildAbsUrlFromPaperId(paperId) {
  return `https://arxiv.org/abs/${paperId}`;
}

function looksLikeArxivPaperId(paperId) {
  return /^\d{4}\.\d{4,5}$/i.test(paperId) || /^[a-z.-]+\/\d{7}$/i.test(paperId);
}

function formatPaperIdentifier(paper) {
  if (!paper) {
    return '';
  }

  if (paper.displayId) {
    return paper.displayId;
  }

  const paperId = String(paper.id || '').trim();
  if (looksLikeArxivPaperId(paperId)) {
    return paperId;
  }

  if (Number.isFinite(paper.order)) {
    return `#${paper.order}`;
  }

  return paperId;
}

function getPaperById(paperId) {
  return state.papers.find((paper) => paper.id === paperId) || null;
}

function getDecisionAbsUrl(paperId, decisionEntry = {}) {
  return decisionEntry.absUrl || getPaperById(paperId)?.absUrl || buildAbsUrlFromPaperId(paperId);
}

function inferDecisionSourceType(decisionEntry = {}, paperId = '') {
  const explicitSourceType = String(decisionEntry.sourceType || '').trim();
  if (explicitSourceType === 'arxiv' || explicitSourceType === 'icse') {
    return explicitSourceType;
  }

  const resolvedPaperId = String(paperId || '').trim();
  if (looksLikeArxivPaperId(resolvedPaperId)) {
    return 'arxiv';
  }

  const paper = resolvedPaperId ? getPaperById(resolvedPaperId) : null;
  if (paper?.sourceUrl && isIcseCollectionSource(paper.sourceUrl)) {
    return 'icse';
  }

  const absUrl = getDecisionAbsUrl(resolvedPaperId, decisionEntry);
  if (/arxiv\.org\/abs\//i.test(absUrl)) {
    return 'arxiv';
  }

  if (/researchr\.org|icse-conferences\.org/i.test(absUrl)) {
    return 'icse';
  }

  return 'arxiv';
}

function getDecisionSyncTarget() {
  return isIcseCollectionSource(state.sourceUrl || getSourceUrlFromQuery()) ? 'icse' : 'arxiv';
}

function getDecisionsForSyncTarget(syncTarget = getDecisionSyncTarget()) {
  const normalizedSyncTarget = syncTarget === 'icse' ? 'icse' : 'arxiv';
  return Object.fromEntries(
    Object.entries(normalizeDecisionMap(state.decisions)).filter(([paperId, decisionEntry]) => (
      inferDecisionSourceType(decisionEntry, paperId) === normalizedSyncTarget
    )),
  );
}

function normalizeDecisionEntry(decisionEntry, paperId = '') {
  if (!decisionEntry || !DECISIONS[decisionEntry.decision]) {
    return null;
  }

  const resolvedPaperId = paperId || extractArxivIdFromUrl(decisionEntry.absUrl) || '';
  if (!resolvedPaperId) {
    return null;
  }

  return {
    decision: decisionEntry.decision,
    decidedAt: normalizeUpdatedAt(decisionEntry.decidedAt) || new Date().toISOString(),
    absUrl: getDecisionAbsUrl(resolvedPaperId, decisionEntry),
    sourceType: inferDecisionSourceType(decisionEntry, resolvedPaperId),
  };
}

function normalizeDecisionMap(rawDecisions = {}) {
  const normalized = {};

  Object.entries(rawDecisions).forEach(([paperId, decisionEntry]) => {
    const normalizedEntry = normalizeDecisionEntry(decisionEntry, paperId);
    if (normalizedEntry) {
      normalized[paperId] = normalizedEntry;
    }
  });

  return normalized;
}

function mergeDecisionMaps(localDecisions, remoteDecisions) {
  const merged = { ...localDecisions };

  Object.entries(remoteDecisions).forEach(([paperId, remoteEntry]) => {
    const localEntry = merged[paperId];
    if (!localEntry || isRemoteSettingsNewer(remoteEntry.decidedAt, localEntry.decidedAt)) {
      merged[paperId] = remoteEntry;
    }
  });

  return merged;
}

const auth = window.PinderAuth?.createController({
  elements,
  normalizeSettings,
  normalizeDecisionMap,
  mergeDecisionMaps,
  getDecisionAbsUrl,
  getDecisionSyncTarget,
  getDecisionsForSyncTarget,
  getSettings: () => state.settings,
  setSettings: (settings) => {
    state.settings = normalizeSettings(settings);
  },
  saveSettings,
  applySettings,
  getDecisions: () => state.decisions,
  setDecisions: (decisions) => {
    state.decisions = normalizeDecisionMap(decisions);
  },
  saveDecisions,
  renderIfReady: () => {
    if (state.papers.length) {
      render();
    }
  },
  closeSettingsMenu,
  flashStatus,
  clearDecisionSyncTimer: () => {
    window.clearTimeout(state.decisionSyncTimer);
  },
});

init();

function scheduleDecisionSync() {
  if (!auth?.isSignedIn()) {
    return;
  }

  window.clearTimeout(state.decisionSyncTimer);
  state.decisionSyncTimer = window.setTimeout(() => {
    auth.syncDecisionsToCloud({ interactive: false });
  }, 900);
}

function applySettings() {
  const showActionButtons = state.settings.showActionButtons !== false;
  const showTitleTagline = state.settings.showTitleTagline !== false;
  const showAuthors = state.settings.showAuthors !== false;

  elements.showButtonsToggle.checked = showActionButtons;
  elements.showTitleToggle.checked = showTitleTagline;
  elements.showAuthorsToggle.checked = showAuthors;
  elements.actionGrid.classList.toggle('hidden', !showActionButtons);
  elements.topbarBrand.classList.toggle('hidden', !showTitleTagline);
  elements.authorsSection.classList.toggle('hidden', !showAuthors);
  elements.nextAuthors.classList.toggle('hidden', !showAuthors);
}

function openFilterMenu() {
  closeSettingsMenu();
  closeSourceMenu();
  state.authorFilterOpen = true;
  elements.filterMenu.classList.remove('hidden');
  elements.filterButton.setAttribute('aria-expanded', 'true');
  renderAuthorFilter();
}

function closeFilterMenu() {
  state.authorFilterOpen = false;
  elements.filterMenu.classList.add('hidden');
  elements.filterButton.setAttribute('aria-expanded', 'false');
}

function toggleViewMode() {
  state.viewMode = state.viewMode === 'explore' ? 'swipe' : 'explore';
  elements.modeToggleButton.textContent = state.viewMode === 'explore' ? 'Swipe mode' : 'Explore Map';
  render();
}

function toggleFilterMenu() {
  if (state.authorFilterOpen) {
    closeFilterMenu();
    return;
  }
  openFilterMenu();
}

function onSearchInputChange(event) {
  state.searchQuery = (event.target.value || '').trim();
  if (state.searchQuery) {
    elements.searchClearButton.classList.remove('hidden');
  } else {
    elements.searchClearButton.classList.add('hidden');
  }
  render();
}

function onSearchClear() {
  state.searchQuery = '';
  elements.searchInput.value = '';
  elements.searchClearButton.classList.add('hidden');
  elements.searchInput.focus();
  render();
}

function onAuthorSearchInput(event) {
  renderAuthorFilter(event.target.value);
}

function getPaperAuthorsList(paper) {
  if (Array.isArray(paper.authors) && paper.authors.length) {
    return paper.authors;
  }
  const authorsText = String(paper?.authorsText || '').trim();
  if (!authorsText || /^unknown authors$/i.test(authorsText)) {
    return [];
  }
  return authorsText.split(/\s*,\s*/).filter(Boolean);
}

function getAllKnownPapers() {
  const all = new Map();
  state.papers.forEach(p => all.set(p.id, p));
  if (state.icseVisualizationTracks) {
    state.icseVisualizationTracks.forEach(track => {
      if (Array.isArray(track.papers)) {
        track.papers.forEach(p => all.set(p.id, p));
      }
    });
  }
  return Array.from(all.values());
}

function renderAuthorFilter(searchQuery = elements.authorSearchInput.value) {
  const query = (searchQuery || '').trim().toLowerCase();

  const authorCounts = new Map();
  getAllKnownPapers().forEach((paper) => {
    const authors = getPaperAuthorsList(paper);
    authors.forEach((author) => {
      authorCounts.set(author, (authorCounts.get(author) || 0) + 1);
    });
  });

  const sortedAuthors = Array.from(authorCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const fragment = document.createDocumentFragment();

  sortedAuthors.forEach(([author, count]) => {
    if (query && !author.toLowerCase().includes(query)) {
      return;
    }

    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = author;
    checkbox.checked = !state.uncheckedAuthors.has(author);

    const text = document.createElement('span');
    text.textContent = `${author} (${count})`;

    label.append(checkbox, text);
    fragment.appendChild(label);
  });

  elements.authorList.replaceChildren(fragment);
}

function selectAllAuthors() {
  state.uncheckedAuthors.clear();
  renderAuthorFilter();
  render();
}

function clearAllAuthors() {
  const allAuthors = new Set();
  getAllKnownPapers().forEach((paper) => {
    getPaperAuthorsList(paper).forEach((author) => allAuthors.add(author));
  });
  state.uncheckedAuthors = allAuthors;
  renderAuthorFilter();
  render();
}

function onAuthorCheckboxChange(event) {
  if (event.target.type === 'checkbox') {
    const author = event.target.value;
    if (event.target.checked) {
      state.uncheckedAuthors.delete(author);
    } else {
      state.uncheckedAuthors.add(author);
    }
    render();
  }
}

function openSettingsMenu() {
  closeFilterMenu();
  closeSourceMenu();
  state.settingsOpen = true;
  elements.settingsMenu.classList.remove('hidden');
  elements.settingsButton.setAttribute('aria-expanded', 'true');
}

function closeSettingsMenu() {
  state.settingsOpen = false;
  elements.settingsMenu.classList.add('hidden');
  elements.settingsButton.setAttribute('aria-expanded', 'false');
}

function toggleSettingsMenu() {
  if (state.settingsOpen) {
    closeSettingsMenu();
    return;
  }

  openSettingsMenu();
}

function persistSettingsChange(message) {
  state.settings.updatedAt = new Date().toISOString();
  saveSettings();
  applySettings();
  closeSettingsMenu();

  if (auth.isSignedIn()) {
    auth.syncSettingsToCloud({ interactive: false });
  }

  flashStatus(message);
}

function onShowButtonsToggleChange(event) {
  state.settings.showActionButtons = event.target.checked;
  persistSettingsChange(
    event.target.checked
      ? 'Button controls shown.'
      : 'Button controls hidden. Swipe or use arrow keys to rate papers.',
  );
}

function onShowTitleToggleChange(event) {
  state.settings.showTitleTagline = event.target.checked;
  persistSettingsChange(event.target.checked ? 'Title and tagline shown.' : 'Title and tagline hidden.');
}

function onShowAuthorsToggleChange(event) {
  state.settings.showAuthors = event.target.checked;
  persistSettingsChange(event.target.checked ? 'Authors shown.' : 'Authors hidden.');
}

function onDocumentClick(event) {
  if (!(event.target instanceof Node)) {
    return;
  }

  if (
    state.settingsOpen
    && !elements.settingsMenu.contains(event.target)
    && !elements.settingsButton.contains(event.target)
  ) {
    closeSettingsMenu();
  }

  if (
    state.authorFilterOpen
    && !elements.filterMenu.contains(event.target)
    && !elements.filterButton.contains(event.target)
  ) {
    closeFilterMenu();
  }

  if (
    state.sourceMenuOpen
    && !elements.sourceMenu.contains(event.target)
    && !elements.sourceSwitcherButton.contains(event.target)
  ) {
    closeSourceMenu();
  }
}

function bindEvents() {
  elements.currentCard.addEventListener('pointerdown', onPointerDown);
  elements.currentCard.addEventListener('pointermove', onPointerMove);
  elements.currentCard.addEventListener('pointerup', onPointerUp);
  elements.currentCard.addEventListener('pointercancel', onPointerCancel);
  elements.abstractModal.addEventListener('click', onAbstractModalClick);
  elements.icsePaperMap.addEventListener('click', onIcsePaperMapClick);
  elements.icsePaperMap.addEventListener('mouseover', onIcsePaperMapMouseOver);
  elements.icsePaperMap.addEventListener('mousemove', onIcsePaperMapMouseMove);
  elements.icsePaperMap.addEventListener('mouseout', onIcsePaperMapMouseOut);
  elements.icsePaperMap.addEventListener('scroll', hideIcseVisualizationTooltip, { passive: true });
  elements.icsePaperMap.addEventListener('focusin', onIcsePaperMapFocusIn);
  elements.icsePaperMap.addEventListener('focusout', onIcsePaperMapFocusOut);

  elements.modeToggleButton.addEventListener('click', toggleViewMode);
  elements.topAuthButton.addEventListener('click', auth.onTopAuthButtonClick);
  elements.sourceSwitcherButton.addEventListener('click', toggleSourceMenu);
  elements.sourceArxivOption.addEventListener('click', () => switchSourceMode('arxiv'));
  elements.sourceIcseOption.addEventListener('click', () => switchSourceMode('icse'));
  elements.settingsButton.addEventListener('click', toggleSettingsMenu);
  elements.filterButton.addEventListener('click', toggleFilterMenu);
  elements.searchInput.addEventListener('input', onSearchInputChange);
  elements.searchClearButton.addEventListener('click', onSearchClear);
  elements.authorSearchInput.addEventListener('input', onAuthorSearchInput);
  elements.selectAllAuthorsButton.addEventListener('click', selectAllAuthors);
  elements.clearAllAuthorsButton.addEventListener('click', clearAllAuthors);
  elements.authorList.addEventListener('change', onAuthorCheckboxChange);
  elements.showButtonsToggle.addEventListener('change', onShowButtonsToggleChange);
  elements.showTitleToggle.addEventListener('change', onShowTitleToggleChange);
  elements.showAuthorsToggle.addEventListener('change', onShowAuthorsToggleChange);
  elements.trackPicker.addEventListener('change', onTrackPickerChange);

  elements.actionButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const decision = button.dataset.decision;
      if (decision) {
        rateCurrent(decision);
      }
    });
  });

  elements.undoButton.addEventListener('click', undoLastDecision);
  elements.exportButton.addEventListener('click', exportDecisions);

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
}

function getIcsePaperMapButtonFromTarget(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  const button = target.closest('.icse-paper-square');
  return button && elements.icsePaperMap.contains(button) ? button : null;
}

function getIcseVisualizationPaperFromButton(button) {
  if (!button) {
    return null;
  }

  return state.icseVisualizationPaperByKey.get(String(button.dataset.paperKey || '').trim()) || null;
}

function onIcsePaperMapClick(event) {
  const button = getIcsePaperMapButtonFromTarget(event.target);
  if (!button) {
    return;
  }

  const paper = getIcseVisualizationPaperFromButton(button);
  if (!paper) {
    return;
  }

  openAbstractModal(paper);
}

function onIcsePaperMapMouseOver(event) {
  const button = getIcsePaperMapButtonFromTarget(event.target);
  if (!button) {
    return;
  }

  setIcseVisualizationHoverFromButton(button, {
    clientX: event.clientX,
    clientY: event.clientY,
  });
}

function onIcsePaperMapMouseMove(event) {
  const button = getIcsePaperMapButtonFromTarget(event.target);
  if (!button) {
    return;
  }

  if (
    state.icseVisualizationHoveredPaperKey !== String(button.dataset.paperKey || '').trim()
    || elements.icseVisualizationTooltip.classList.contains('hidden')
  ) {
    setIcseVisualizationHoverFromButton(button, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
    return;
  }

  positionIcseVisualizationTooltip(event.clientX, event.clientY);
}

function onIcsePaperMapMouseOut(event) {
  const button = getIcsePaperMapButtonFromTarget(event.target);
  if (!button) {
    return;
  }

  const nextButton = getIcsePaperMapButtonFromTarget(event.relatedTarget);
  if (nextButton) {
    return;
  }

  clearIcseVisualizationHover(button.dataset.paperKey);
}

function onIcsePaperMapFocusIn(event) {
  const button = getIcsePaperMapButtonFromTarget(event.target);
  if (!button) {
    return;
  }

  setIcseVisualizationHoverFromButton(button);
}

function onIcsePaperMapFocusOut(event) {
  const button = getIcsePaperMapButtonFromTarget(event.target);
  if (!button) {
    return;
  }

  const nextButton = getIcsePaperMapButtonFromTarget(event.relatedTarget);
  if (nextButton) {
    return;
  }

  clearIcseVisualizationHover(button.dataset.paperKey);
}

function onAbstractModalClick(event) {
  if (event.target === elements.abstractModal || event.target === elements.abstractModalBackdrop) {
    closeAbstractModal();
  }
}

function toggleAbstractModal() {
  if (state.abstractModalOpen) {
    closeAbstractModal();
    return;
  }

  openAbstractModal();
}

function openAbstractModal(paper = getCurrentPaper()) {
  if (!paper) {
    return;
  }

  state.icseVisualizationHoveredPaperKey = '';
  hideIcseVisualizationTooltip();
  state.abstractModalPaper = paper;
  updateAbstractModalContent();
  state.abstractModalOpen = true;

  if (!paper.loaded && !paper.loading) {
    loadPaperDetails(paper)
      .then(() => updateAbstractModalContent())
      .catch((error) => {
        console.warn('Could not load abstract for modal.', error);
        updateAbstractModalContent();
      });
  }
  elements.abstractModal.classList.remove('hidden');
  elements.abstractModal.setAttribute('aria-hidden', 'false');
  elements.abstractModalBody.scrollTop = 0;
  document.body.classList.add('modal-open');

  window.requestAnimationFrame(() => {
    elements.abstractModalSheet.focus();
  });
}

function closeAbstractModal() {
  if (!state.abstractModalOpen) {
    state.abstractModalPaper = null;
    return;
  }

  state.abstractModalOpen = false;
  state.abstractModalPaper = null;
  elements.abstractModal.classList.add('hidden');
  elements.abstractModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function updateAbstractModalContent(paper = state.abstractModalPaper || getCurrentPaper()) {
  if (!paper) {
    elements.abstractModalTitle.textContent = '';
    elements.abstractModalText.textContent = '';
    elements.abstractModalHint.textContent = 'Arrow keys rate · Esc or tap outside closes';
    return;
  }

  elements.abstractModalTitle.textContent = paper.title || paper.id || 'Abstract';
  elements.abstractModalText.textContent = !paper.loaded
    ? 'Loading abstract…'
    : (paper.abstract || paper.error || 'No abstract available.');
  elements.abstractModalHint.textContent = getAbstractModalHintText(paper);
}

function getAbstractModalHintText(paper) {
  const decisionKey = getDecisionKeyForPaper(paper);
  const decisionLabel = decisionKey ? DECISIONS[decisionKey].label : 'Unreviewed';
  return `Current: ${decisionLabel} · Arrow keys rate · Esc or tap outside closes`;
}

function onKeyDown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    elements.searchInput.focus();
    return;
  }

  if (event.key === 'Escape') {
    if (state.abstractModalOpen) {
      closeAbstractModal();
      return;
    }

    if (state.settingsOpen) {
      closeSettingsMenu();
      return;
    }

    if (state.authorFilterOpen) {
      closeFilterMenu();
      return;
    }

    if (state.sourceMenuOpen) {
      closeSourceMenu();
      return;
    }
  }

  if (state.settingsOpen || state.sourceMenuOpen || state.authorFilterOpen) {
    return;
  }

  if (isEditableElement(document.activeElement)) {
    return;
  }

  if (isUndoKeyboardShortcut(event)) {
    event.preventDefault();
    undoLastDecision();
    return;
  }

  const keyMap = {
    ArrowDown: 'reject',
    ArrowLeft: 'weakReject',
    ArrowRight: 'weakAccept',
    ArrowUp: 'accept',
  };

  if (state.abstractModalOpen) {
    if (keyMap[event.key]) {
      event.preventDefault();
      rateAbstractModalPaper(keyMap[event.key]);
      return;
    }

    if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'u') {
      event.preventDefault();
      undoLastDecision();
      updateAbstractModalContent();
    }
    return;
  }

  if (keyMap[event.key]) {
    event.preventDefault();
    rateCurrent(keyMap[event.key]);
    return;
  }

  if (!event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'u') {
    event.preventDefault();
    undoLastDecision();
  }
}

function isEditableElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const tagName = element.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || element.isContentEditable;
}

function isUndoKeyboardShortcut(event) {
  if (!event || event.altKey) {
    return false;
  }

  const key = String(event.key || '').toLowerCase();
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && key === 'z';
}

function onPointerDown(event) {
  if (state.animating || !getCurrentPaper()) {
    return;
  }

  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (target && target.closest('a, button')) {
    return;
  }

  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dx: 0,
    dy: 0,
    targetOpensAbstract: Boolean(target && elements.paperCardContent.contains(target)),
  };

  elements.currentCard.setPointerCapture(event.pointerId);
  elements.currentCard.classList.add('dragging');
}

function onPointerMove(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) {
    return;
  }

  state.drag.dx = event.clientX - state.drag.startX;
  state.drag.dy = event.clientY - state.drag.startY;

  applyCardTransform(state.drag.dx, state.drag.dy);
  updateDecisionBadge(getDecisionFromVector(state.drag.dx, state.drag.dy));
}

function onPointerUp(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) {
    return;
  }

  finishDrag();
}

function onPointerCancel(event) {
  if (!state.drag || event.pointerId !== state.drag.pointerId) {
    return;
  }

  finishDrag(true);
}

function finishDrag(cancelled = false) {
  const drag = state.drag;
  state.drag = null;

  if (!drag) {
    return;
  }

  elements.currentCard.classList.remove('dragging');

  const decision = cancelled ? null : getDecisionFromVector(drag.dx, drag.dy);
  const wasTap = !cancelled
    && drag.targetOpensAbstract
    && Math.hypot(drag.dx, drag.dy) <= CARD_TAP_DISTANCE_THRESHOLD;

  if (!decision) {
    resetCardTransform();
    updateDecisionBadge(null);

    if (wasTap) {
      toggleAbstractModal();
    }
    return;
  }

  animateDecision(decision, drag.dx, drag.dy);
}

function getDecisionFromVector(dx, dy) {
  const horizontalDistance = Math.abs(dx);
  const verticalDistance = Math.abs(dy);
  const xThreshold = Math.min(140, elements.currentCard.offsetWidth * 0.24);
  const yThreshold = Math.min(140, elements.currentCard.offsetHeight * 0.16);

  if (horizontalDistance >= verticalDistance) {
    if (dx <= -xThreshold) {
      return 'weakReject';
    }
    if (dx >= xThreshold) {
      return 'weakAccept';
    }
  } else {
    if (dy <= -yThreshold) {
      return 'accept';
    }
    if (dy >= yThreshold) {
      return 'reject';
    }
  }

  return null;
}

function applyCardTransform(dx, dy) {
  const rotation = dx * 0.045;
  const progress = Math.min(1, Math.hypot(dx, dy) / 180);

  elements.currentCard.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${rotation}deg)`;
  elements.currentCard.style.opacity = String(1 - progress * 0.12);
  elements.nextCard.style.transform = `translateY(${12 - progress * 8}px) scale(${0.98 + progress * 0.02})`;
  elements.nextCard.style.opacity = String(0.85 + progress * 0.15);
}

function resetCardTransform() {
  elements.currentCard.style.transform = '';
  elements.currentCard.style.opacity = '';
  elements.nextCard.style.transform = '';
  elements.nextCard.style.opacity = '';
}

function updateDecisionBadge(decisionKey) {
  if (!decisionKey) {
    elements.decisionBadge.className = 'decision-badge hidden';
    elements.decisionBadge.textContent = '';
    return;
  }

  const decision = DECISIONS[decisionKey];
  elements.decisionBadge.className = `decision-badge ${decision.className}`;
  elements.decisionBadge.textContent = decision.shortLabel;
}

function rateCurrent(decisionKey) {
  if (state.animating || !getCurrentPaper()) {
    return;
  }

  animateDecision(decisionKey);
}

function rateAbstractModalPaper(decisionKey) {
  const paper = state.abstractModalPaper;
  if (!paper || !DECISIONS[decisionKey]) {
    return;
  }

  recordDecision(paper, decisionKey);
  updateAbstractModalContent(paper);
  render();
}

function animateDecision(decisionKey, dx = 0, dy = 0) {
  const paper = getCurrentPaper();
  if (!paper) {
    return;
  }

  const decision = DECISIONS[decisionKey];
  if (!decision) {
    return;
  }

  closeAbstractModal();
  state.animating = true;
  updateDecisionBadge(decisionKey);

  const flingX = decision.vector.x * window.innerWidth * 1.15 + dx * 0.2;
  const flingY = decision.vector.y * window.innerHeight * 1.1 + dy * 0.2;
  const rotation = flingX * 0.04;

  elements.currentCard.style.transform = `translate3d(${flingX}px, ${flingY}px, 0) rotate(${rotation}deg)`;
  elements.currentCard.style.opacity = '0';

  window.setTimeout(() => {
    recordDecision(paper, decisionKey);
    state.animating = false;
    updateDecisionBadge(null);
    resetCardTransform();
    render();
  }, 220);
}

function recordDecision(paper, decisionKey) {
  state.decisions[paper.id] = {
    decision: decisionKey,
    decidedAt: new Date().toISOString(),
    absUrl: paper.absUrl,
    sourceType: isIcseCollectionSource(paper?.sourceUrl || state.sourceUrl) ? 'icse' : 'arxiv',
  };

  state.undoStack.push(paper.id);
  saveDecisions();
  scheduleDecisionSync();
}

function undoLastDecision() {
  const undoId = state.undoStack.pop() || findMostRecentDecisionId();
  if (!undoId) {
    flashStatus('Nothing to undo.');
    return;
  }

  delete state.decisions[undoId];
  saveDecisions();
  scheduleDecisionSync();

  render();
  flashStatus('Undid the last review.');
}

function findMostRecentDecisionId() {
  const currentPaperIds = new Set(state.papers.map((paper) => paper.id));

  return Object.entries(state.decisions)
    .filter(([paperId]) => currentPaperIds.has(paperId))
    .sort(([, a], [, b]) => new Date(b.decidedAt) - new Date(a.decidedAt))[0]?.[0];
}

function exportDecisions() {
  const reviewed = getReviewedPapers();
  if (!reviewed.length) {
    flashStatus('No reviews to export yet.');
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    sourceUrl: state.sourceUrl,
    reviewedCount: reviewed.length,
    decisions: reviewed,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pinder-reviews-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  flashStatus('Exported reviews as JSON.');
}

function render() {
  const visiblePapers = state.papers.filter(isPaperVisible);
  const undecidedPapers = state.papers.filter((paper) => !state.decisions[paper.id]);
  const remainingPapers = getRemainingPapers();
  const currentPaper = remainingPapers[0] || null;
  const nextPaper = remainingPapers[1] || null;
  const total = visiblePapers.length;
  const reviewedCount = total - remainingPapers.length;
  const totalCounts = getDecisionCounts();
  const activeSourcePeriod = getActiveSourcePeriod();
  const activePapers = getPapersForSourcePeriod(activeSourcePeriod);
  const activeCounts = getDecisionCounts(activeSourcePeriod);
  const waitingForOlderPapers = !currentPaper && !undecidedPapers.length && canLoadOlderPapers();

  let progressTotal = total;
  let progressReviewed = reviewedCount;
  if (activeSourcePeriod) {
    progressTotal = activePapers.length;
    progressReviewed = activePapers.reduce((n, paper) => n + (state.decisions[paper.id] ? 1 : 0), 0);
  }
  elements.progressFill.style.width = `${progressTotal ? (progressReviewed / progressTotal) * 100 : 0}%`;

  updateSourceLabel();

  renderStats(activeCounts);
  renderIcseVisualization();
  elements.undoButton.disabled = !reviewedCount;
  elements.exportButton.disabled = !reviewedCount;

  const isExplore = state.viewMode === 'explore';
  document.body.classList.toggle('explore-mode', isExplore);
  
  elements.progressPanel.classList.toggle('hidden', isExplore);
  elements.currentCard.classList.toggle('hidden', !currentPaper);
  elements.nextCard.classList.toggle('hidden', !currentPaper);
  elements.cardStack.classList.toggle('hidden', isExplore || !currentPaper);
  elements.emptyState.classList.toggle('hidden', isExplore || Boolean(currentPaper) || waitingForOlderPapers);
  
  const footerActions = document.querySelector('.footer-actions');
  if (footerActions) {
    footerActions.classList.toggle('hidden', isExplore);
  }

  if (!isExplore && currentPaper) {
    renderCurrentPaper(currentPaper);
    renderNextPaper(nextPaper);
    prefetchVisiblePapersSoon();
    ensureOlderPaperSupplySoon();
    return;
  }

  if (waitingForOlderPapers) {
    showStatus('Loading older papers…');
    ensureOlderPaperSupply({ urgent: true })
      .then(() => {
        if (getCurrentPaper()) {
          hideStatus();
          render();
          return;
        }

        if (!canLoadOlderPapers()) {
          hideStatus();
          render();
        }
      })
      .catch((error) => {
        console.error(error);
        showStatus(
          'Could not load older papers right now. Hard refresh and try again. If the problem persists, the public CORS proxy may be temporarily unavailable.',
          true,
        );
        renderSummary(totalCounts, total);
        elements.emptyState.classList.remove('hidden');
      });
    return;
  }

  renderSummary(totalCounts, total);
}

function renderCurrentPaper(paper) {
  elements.paperId.textContent = formatPaperIdentifier(paper);
  elements.paperTitle.textContent = paper.title || `Loading ${paper.id}…`;
  elements.paperAuthors.textContent = !paper.loaded
    ? 'Loading authors…'
    : (paper.authorsText || 'Unknown authors');
  elements.paperAbstract.textContent = !paper.loaded
    ? 'Loading abstract…'
    : (paper.abstract || paper.error || 'No abstract available.');
  elements.absLink.href = paper.absUrl;
  elements.pdfLink.href = paper.pdfUrl;
  updateAbstractModalContent();
}

function renderNextPaper(paper) {
  if (!paper) {
    elements.nextTitle.textContent = 'You are almost done.';
    elements.nextAuthors.textContent = 'No papers after this one.';
    return;
  }

  elements.nextTitle.textContent = paper.title || `Loading ${paper.id}…`;
  elements.nextAuthors.textContent = !paper.loaded
    ? 'Loading authors…'
    : (paper.authorsText || 'Unknown authors');
}

function renderSummary(counts, total) {
  elements.emptySummary.textContent = `You reviewed ${total} papers from this feed.`;
  elements.summaryGrid.innerHTML = [
    summaryCardMarkup('Accept', counts.accept),
    summaryCardMarkup('Weak accept', counts.weakAccept),
    summaryCardMarkup('Weak reject', counts.weakReject),
    summaryCardMarkup('Reject', counts.reject),
  ].join('');
}

function renderStats(counts) {
  const statsText = `Accept ${counts.accept} · Weak accept ${counts.weakAccept} · Weak reject ${counts.weakReject} · Reject ${counts.reject}`;
  elements.stats.textContent = statsText;
  elements.progressPanel.setAttribute('aria-label', `Review progress. ${statsText}`);
}

function renderIcseVisualization() {
  const data = getIcseVisualizationData();
  const showVisualization = Boolean(data) && state.viewMode === 'explore';
  elements.icseVisualization.classList.toggle('hidden', !showVisualization);

  if (!showVisualization) {
    state.icseVisualizationHoveredPaperKey = '';
    hideIcseVisualizationTooltip();
    return;
  }

  elements.icseVisualizationSummary.textContent = data.summaryText;
  renderIcseVisualizationLegend(data.decisionCounts, data.totalPaperCount);
  renderIcsePaperMap(data);
}

function renderIcseVisualizationLegend(decisionCounts, totalPaperCount) {
  const legendItems = [
    {
      label: 'Unreviewed',
      className: 'undecided',
      value: totalPaperCount - getReviewedCount(decisionCounts),
    },
    {
      label: 'Accept',
      className: DECISIONS.accept.className,
      value: decisionCounts.accept,
    },
    {
      label: 'Weak accept',
      className: DECISIONS.weakAccept.className,
      value: decisionCounts.weakAccept,
    },
    {
      label: 'Weak reject',
      className: DECISIONS.weakReject.className,
      value: decisionCounts.weakReject,
    },
    {
      label: 'Reject',
      className: DECISIONS.reject.className,
      value: decisionCounts.reject,
    },
  ];

  const fragment = document.createDocumentFragment();
  legendItems.forEach((item) => {
    const chip = document.createElement('div');
    chip.className = 'icse-legend-chip';

    const swatch = document.createElement('span');
    swatch.className = `icse-legend-swatch ${item.className}`;
    swatch.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'icse-legend-label';
    label.textContent = `${item.label} ${formatStatNumber(item.value)}`;

    chip.append(swatch, label);
    fragment.appendChild(chip);
  });

  elements.icseVisualizationLegend.replaceChildren(fragment);
}

function renderIcsePaperMap(data) {
  const structureKey = data.tracks
    .map((track) => `${track.key}:${track.paperCount}`)
    .join('|');

  if (state.icseVisualizationStructureKey !== structureKey) {
    const fragment = document.createDocumentFragment();
    const paperByKey = new Map();

    data.tracks.forEach((track) => {
      const row = document.createElement('section');
      row.className = 'icse-paper-map-row';
      row.dataset.trackKey = track.key;

      const meta = document.createElement('div');
      meta.className = 'icse-paper-map-meta';

      const year = document.createElement('p');
      year.className = 'icse-paper-map-year';
      year.textContent = `${track.year || ''} - ${formatStatNumber(track.paperCount)}`;

      meta.append(year);

      const squares = document.createElement('div');
      squares.className = 'icse-paper-map-squares';
      squares.setAttribute('role', 'list');
      squares.setAttribute('aria-label', `${track.label || `ICSE ${track.year}`}. ${track.paperCount} papers.`);

      track.papers.forEach((paper, index) => {
        const paperKey = buildIcseVisualizationPaperKey(track, paper, index);
        paperByKey.set(paperKey, paper);

        const square = document.createElement('button');
        square.type = 'button';
        square.className = 'icse-paper-square';
        square.dataset.paperKey = paperKey;
        square.dataset.paperId = paper.id || '';
        updateIcsePaperSquareState(square, paper);
        squares.appendChild(square);
      });

      row.append(meta, squares);
      fragment.appendChild(row);
    });

    state.icseVisualizationPaperByKey = paperByKey;
    state.icseVisualizationStructureKey = structureKey;
    elements.icsePaperMap.replaceChildren(fragment);
  }

  syncIcsePaperMapSelection(data.selectedTrackKey);
  syncIcsePaperMapDecisions(data.tracks);
}

function syncIcsePaperMapSelection(selectedTrackKey) {
  Array.from(elements.icsePaperMap.querySelectorAll('.icse-paper-map-row')).forEach((row) => {
    row.classList.toggle('selected', row.dataset.trackKey === selectedTrackKey);
  });
}

function syncIcsePaperMapDecisions(tracks = []) {
  const trackByKey = new Map(
    tracks.map((track) => [String(track.key || '').trim(), track]),
  );

  Array.from(elements.icsePaperMap.querySelectorAll('.icse-paper-map-row')).forEach((row) => {
    const trackKey = String(row.dataset.trackKey || '').trim();
    const track = trackByKey.get(trackKey);
    if (!track) {
      return;
    }

    const squares = row.querySelector('.icse-paper-map-squares');
    if (!(squares instanceof HTMLElement)) {
      return;
    }

    const buttonByKey = new Map(
      Array.from(squares.querySelectorAll('.icse-paper-square'))
        .map((button) => [String(button.dataset.paperKey || '').trim(), button]),
    );

    getSortedIcseVisualizationTrackPaperEntries(track).forEach(({ key, paper }) => {
      const button = buttonByKey.get(key);
      if (!button) {
        return;
      }

      updateIcsePaperSquareState(button, paper);
      squares.appendChild(button);
    });
  });
}

function updateIcsePaperSquareState(square, paper) {
  const decisionKey = getDecisionKeyForPaper(paper);
  square.classList.remove('undecided');
  Object.values(DECISIONS).forEach((decision) => {
    square.classList.remove(decision.className);
  });

  square.classList.add(decisionKey ? DECISIONS[decisionKey].className : 'undecided');
  square.setAttribute('aria-label', buildIcseVisualizationPaperAriaLabel(paper, decisionKey));
}

function getSortedIcseVisualizationTrackPaperEntries(track) {
  return track.papers
    .map((paper, index) => ({
      key: buildIcseVisualizationPaperKey(track, paper, index),
      paper,
      index,
    }))
    .sort((left, right) => (
      getIcseVisualizationDecisionSortOrder(left.paper) - getIcseVisualizationDecisionSortOrder(right.paper)
      || left.index - right.index
    ));
}

function getIcseVisualizationDecisionSortOrder(paper) {
  switch (getDecisionKeyForPaper(paper)) {
    case 'accept':
      return 0;
    case 'weakAccept':
      return 1;
    case 'weakReject':
      return 2;
    case 'reject':
      return 3;
    default:
      return 4;
  }
}

function getIcseVisualizationData() {
  if (getCurrentSourceMode() !== 'icse' || !state.icseVisualizationTracks.length) {
    return null;
  }

  const tracks = state.icseVisualizationTracks
    .map((track) => {
      const papers = (Array.isArray(track.papers) ? track.papers : []).filter(isPaperVisible);
      return {
        ...track,
        key: String(track.key || '').trim(),
        label: String(track.label || track.sourceLabel || '').trim(),
        year: Number(track.year),
        paperCount: Number(track.paperCount),
        papers,
      };
    })
    .filter((track) => track.key && Number.isFinite(track.year) && track.papers.length)
    .map((track) => ({
      ...track,
      paperCount: track.papers.length,
    }))
    .sort((a, b) => b.year - a.year);

  if (!tracks.length) {
    return null;
  }

  const selectedTrackKey = String(state.selectedTrackKey || tracks[0].key || '').trim();
  const selectedTrack = tracks.find((track) => track.key === selectedTrackKey) || tracks[0];
  const allPapers = tracks.flatMap((track) => track.papers);
  const totalPaperCount = allPapers.length;
  const decisionCounts = getDecisionCountsForPaperList(allPapers);
  const reviewedCount = getReviewedCount(decisionCounts);

  return {
    tracks,
    selectedTrackKey: selectedTrack.key,
    totalPaperCount,
    decisionCounts,
    reviewedCount,
    summaryText: `${formatStatNumber(totalPaperCount)} papers · ${formatStatNumber(tracks.length)} ICSE editions · ${formatStatNumber(reviewedCount)} reviewed`,
  };
}

function getDecisionCountsForPaperList(papers) {
  const counts = {
    accept: 0,
    weakAccept: 0,
    weakReject: 0,
    reject: 0,
  };

  papers.forEach((paper) => {
    const decisionKey = getDecisionKeyForPaper(paper);
    if (decisionKey && counts[decisionKey] !== undefined) {
      counts[decisionKey] += 1;
    }
  });

  return counts;
}

function getReviewedCount(counts) {
  return counts.accept + counts.weakAccept + counts.weakReject + counts.reject;
}

function getDecisionKeyForPaper(paper) {
  const decisionKey = state.decisions[paper?.id]?.decision;
  return DECISIONS[decisionKey] ? decisionKey : '';
}

function buildIcseVisualizationPaperKey(track, paper, index) {
  return `${track.key}::${paper.id || 'paper'}::${index + 1}`;
}

function buildIcseVisualizationPaperAriaLabel(paper, decisionKey = getDecisionKeyForPaper(paper)) {
  const title = paper?.title || paper?.id || 'Paper';
  const year = String(paper?.year || '').trim();
  const decisionLabel = decisionKey ? DECISIONS[decisionKey].label : 'Unreviewed';
  const trackLabel = paper?.sourceLabel || (year ? `ICSE ${year}` : 'ICSE');
  return `${trackLabel}. ${title}. ${decisionLabel}. Activate to open abstract.`;
}

function formatIcseTrackRowLabel(track) {
  const rawLabel = String(track?.label || track?.sourceLabel || '').trim();
  const normalizedLabel = rawLabel
    .replace(/^ICSE\s+\d{4}\s*/i, '')
    .replace(/^ICSE\s*/i, '')
    .trim();

  return normalizedLabel || 'Proceedings';
}

function setIcseVisualizationHoverFromButton(button, position = null) {
  const paperKey = String(button?.dataset.paperKey || '').trim();
  if (!paperKey) {
    return;
  }

  const paper = getIcseVisualizationPaperFromButton(button);
  if (!paper) {
    return;
  }

  state.icseVisualizationHoveredPaperKey = paperKey;
  showIcseVisualizationTooltip(paper);

  if (position?.clientX !== undefined && position?.clientY !== undefined) {
    positionIcseVisualizationTooltip(position.clientX, position.clientY);
    return;
  }

  positionIcseVisualizationTooltipFromElement(button);
}

function clearIcseVisualizationHover(paperKey = '') {
  if (paperKey && state.icseVisualizationHoveredPaperKey !== String(paperKey).trim()) {
    return;
  }

  state.icseVisualizationHoveredPaperKey = '';
  hideIcseVisualizationTooltip();
}

function showIcseVisualizationTooltip(paper) {
  elements.icseVisualizationTooltip.textContent = paper?.title || paper?.id || 'Paper';
  elements.icseVisualizationTooltip.classList.remove('hidden');
  elements.icseVisualizationTooltip.setAttribute('aria-hidden', 'false');
}

function hideIcseVisualizationTooltip() {
  elements.icseVisualizationTooltip.classList.add('hidden');
  elements.icseVisualizationTooltip.setAttribute('aria-hidden', 'true');
}

function positionIcseVisualizationTooltipFromElement(element) {
  if (!(element instanceof Element)) {
    return;
  }

  const rect = element.getBoundingClientRect();
  positionIcseVisualizationTooltip(rect.left + rect.width / 2, rect.bottom);
}

function positionIcseVisualizationTooltip(clientX, clientY) {
  if (elements.icseVisualizationTooltip.classList.contains('hidden')) {
    return;
  }

  const offsetX = 12;
  const offsetY = 18;
  const viewportPadding = 12;
  let left = clientX + offsetX;
  let top = clientY + offsetY;

  elements.icseVisualizationTooltip.style.left = `${Math.round(left)}px`;
  elements.icseVisualizationTooltip.style.top = `${Math.round(top)}px`;

  const rect = elements.icseVisualizationTooltip.getBoundingClientRect();
  if (left + rect.width > window.innerWidth - viewportPadding) {
    left = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
  }
  if (top + rect.height > window.innerHeight - viewportPadding) {
    top = Math.max(viewportPadding, clientY - rect.height - 14);
  }

  elements.icseVisualizationTooltip.style.left = `${Math.round(left)}px`;
  elements.icseVisualizationTooltip.style.top = `${Math.round(top)}px`;
}

function formatStatNumber(value, maximumFractionDigits = 0) {
  if (!Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits,
  }).format(value);
}

function summaryCardMarkup(label, value) {
  return `
    <div class="summary-card">
      <span class="summary-label">${label}</span>
      <span class="summary-value">${value}</span>
    </div>
  `;
}

function getCurrentPaper() {
  return getRemainingPapers()[0] || null;
}

function isPaperVisibleByAuthors(paper) {
  if (state.uncheckedAuthors.size === 0) {
    return true;
  }

  const authors = getPaperAuthorsList(paper);
  if (!authors.length) {
    return true;
  }

  return authors.some((author) => !state.uncheckedAuthors.has(author));
}


function isPaperVisibleBySearch(paper) {
  if (!state.searchQuery) {
    return true;
  }

  const query = state.searchQuery.toLowerCase();
  let searchScope = 'all';
  let searchTerm = query;

  if (query.startsWith('title:')) {
    searchScope = 'title';
    searchTerm = query.slice(6).trim();
  } else if (query.startsWith('abstract:')) {
    searchScope = 'abstract';
    searchTerm = query.slice(9).trim();
  } else if (query.startsWith('author:')) {
    searchScope = 'author';
    searchTerm = query.slice(7).trim();
  }

  if (!searchTerm) {
    return true;
  }

  const title = String(paper?.title || '').toLowerCase();
  const abstract = String(paper?.abstract || '').toLowerCase();
  const authorsText = String(paper?.authorsText || '').toLowerCase();
  const authorsList = getPaperAuthorsList(paper).map((a) => a.toLowerCase());

  if (searchScope === 'title') {
    return title.includes(searchTerm);
  }

  if (searchScope === 'abstract') {
    return abstract.includes(searchTerm);
  }

  if (searchScope === 'author') {
    return authorsText.includes(searchTerm) || authorsList.some((a) => a.includes(searchTerm));
  }

  return title.includes(searchTerm) || abstract.includes(searchTerm) || authorsText.includes(searchTerm) || authorsList.some((a) => a.includes(searchTerm));
}

function isPaperVisible(paper) {
  return (
    isPaperVisibleByAuthors(paper)
    && isPaperVisibleBySearch(paper)
  );
}

function getRemainingPapers() {
  return state.papers.filter((paper) => !state.decisions[paper.id] && isPaperVisible(paper));
}

function getReviewedPapers() {
  return state.papers
    .filter((paper) => state.decisions[paper.id])
    .map((paper) => ({
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      authorsText: paper.authorsText,
      abstract: paper.abstract,
      absUrl: getDecisionAbsUrl(paper.id, state.decisions[paper.id]),
      pdfUrl: paper.pdfUrl,
      decision: state.decisions[paper.id].decision,
      decidedAt: state.decisions[paper.id].decidedAt,
    }))
    .sort((a, b) => new Date(a.decidedAt) - new Date(b.decidedAt));
}

function getActiveSourcePeriod() {
  return getCurrentPaper()?.sourcePeriod
    || state.oldestLoadedPeriod
    || state.newestLoadedPeriod
    || describeListUrl(state.sourceUrl)?.period
    || '';
}

function getPapersForSourcePeriod(sourcePeriod = '') {
  const visiblePapers = state.papers.filter(isPaperVisible);
  return sourcePeriod
    ? visiblePapers.filter((paper) => paper.sourcePeriod === sourcePeriod)
    : visiblePapers;
}

function getDecisionCounts(sourcePeriod = '') {
  const counts = {
    accept: 0,
    weakAccept: 0,
    weakReject: 0,
    reject: 0,
  };

  getPapersForSourcePeriod(sourcePeriod).forEach((paper) => {
    const entry = state.decisions[paper.id];
    if (entry && counts[entry.decision] !== undefined) {
      counts[entry.decision] += 1;
    }
  });

  return counts;
}

function formatCustomSourceName(sourceUrl) {
  if (state.sourceLabel) {
    return state.sourceLabel;
  }

  try {
    const parsedUrl = new URL(sourceUrl, window.location.href);
    const lastPathSegment = decodeURIComponent(parsedUrl.pathname.split('/').filter(Boolean).pop() || '');
    const normalizedName = lastPathSegment
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();

    return normalizedName || parsedUrl.host || 'Custom feed';
  } catch (error) {
    return 'Custom feed';
  }
}

function formatSourceLabel() {
  const sourceInfo = describeListUrl(state.sourceUrl);
  const archive = state.feedArchive || sourceInfo?.archive || '';
  const activeSourcePeriod = getActiveSourcePeriod();
  const visibleCount = state.papers.filter(isPaperVisible).length;
  const count = getPapersForSourcePeriod(activeSourcePeriod).length || visibleCount;

  if (!archive || !activeSourcePeriod) {
    return `${formatCustomSourceName(state.sourceUrl)} · ${count} papers loaded`;
  }

  return `arXiv · ${archive} · ${activeSourcePeriod} · ${count} papers loaded`;
}

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'));
  } catch (error) {
    console.warn('Could not read saved settings.', error);
    return normalizeSettings();
  }
}

function saveSettings() {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalizeSettings(state.settings)));
  } catch (error) {
    console.warn('Could not save settings.', error);
  }
}

function loadDecisions() {
  try {
    return normalizeDecisionMap(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch (error) {
    console.warn('Could not read saved decisions.', error);
    return {};
  }
}

function saveDecisions() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeDecisionMap(state.decisions)));
  } catch (error) {
    console.warn('Could not save decisions.', error);
  }
}

function showStatus(message, isError = false) {
  window.clearTimeout(state.statusTimer);
  elements.statusPanel.textContent = message;
  elements.statusPanel.classList.remove('hidden');
  elements.statusPanel.style.color = isError ? '#fecaca' : '#e2e8f0';
}

function hideStatus() {
  elements.statusPanel.classList.add('hidden');
}

function flashStatus(message) {
  showStatus(message);
  state.statusTimer = window.setTimeout(() => {
    hideStatus();
  }, 2200);
}
