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
  abstractModalTitle: document.getElementById('abstractModalTitle'),
  abstractModalText: document.getElementById('abstractModalText'),
  nextTitle: document.getElementById('nextTitle'),
  nextAuthors: document.getElementById('nextAuthors'),
  emptyState: document.getElementById('emptyState'),
  emptySummary: document.getElementById('emptySummary'),
  summaryGrid: document.getElementById('summaryGrid'),
  stats: document.getElementById('stats'),
  undoButton: document.getElementById('undoButton'),
  exportButton: document.getElementById('exportButton'),
  resetButton: document.getElementById('resetButton'),
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

function initializeFeedState(sourceUrl, sourceLabel = '', { trackOptions = [], selectedTrackKey = '' } = {}) {
  state.sourceUrl = sourceUrl;
  state.sourceLabel = sourceLabel;
  state.trackOptions = Array.isArray(trackOptions) ? trackOptions : [];
  state.selectedTrackKey = selectedTrackKey || '';
  state.papers = [];
  state.loadedSourceUrls = [];
  state.loadedPaperIds = new Set();
  state.prefetchedOlderBatch = null;
  state.olderMonthPromise = null;
  state.olderMonthLoading = false;
  state.olderMonthError = '';

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
}

function updateSourceMenu() {
  const currentSourceMode = getCurrentSourceMode();
  elements.sourceArxivOption.classList.toggle('active', currentSourceMode === 'arxiv');
  elements.sourceIcseOption.classList.toggle('active', currentSourceMode === 'icse');
}

function openSourceMenu() {
  closeSettingsMenu();
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
    'abstractModalTitle',
    'abstractModalText',
    'nextTitle',
    'nextAuthors',
    'emptyState',
    'emptySummary',
    'summaryGrid',
    'stats',
    'undoButton',
    'exportButton',
    'resetButton',
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

function openSettingsMenu() {
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

  elements.topAuthButton.addEventListener('click', auth.onTopAuthButtonClick);
  elements.sourceSwitcherButton.addEventListener('click', toggleSourceMenu);
  elements.sourceArxivOption.addEventListener('click', () => switchSourceMode('arxiv'));
  elements.sourceIcseOption.addEventListener('click', () => switchSourceMode('icse'));
  elements.settingsButton.addEventListener('click', toggleSettingsMenu);
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
  elements.resetButton.addEventListener('click', resubmitWeakRejectDecisions);

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
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

function openAbstractModal() {
  const paper = getCurrentPaper();
  if (!paper) {
    return;
  }

  updateAbstractModalContent(paper);
  state.abstractModalOpen = true;
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
    return;
  }

  state.abstractModalOpen = false;
  elements.abstractModal.classList.add('hidden');
  elements.abstractModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function updateAbstractModalContent(paper = getCurrentPaper()) {
  if (!paper) {
    elements.abstractModalTitle.textContent = '';
    elements.abstractModalText.textContent = '';
    return;
  }

  elements.abstractModalTitle.textContent = paper.title || paper.id || 'Abstract';
  elements.abstractModalText.textContent = !paper.loaded
    ? 'Loading abstract…'
    : (paper.abstract || paper.error || 'No abstract available.');
}

function onKeyDown(event) {
  if (event.key === 'Escape') {
    if (state.abstractModalOpen) {
      closeAbstractModal();
      return;
    }

    if (state.settingsOpen) {
      closeSettingsMenu();
      return;
    }

    if (state.sourceMenuOpen) {
      closeSourceMenu();
      return;
    }
  }

  if (state.settingsOpen || state.sourceMenuOpen || state.abstractModalOpen) {
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

function resubmitWeakRejectDecisions() {
  const weakRejectPaperIds = Object.entries(state.decisions)
    .filter(([, decisionEntry]) => decisionEntry?.decision === 'weakReject')
    .map(([paperId]) => paperId);

  if (!weakRejectPaperIds.length) {
    flashStatus('No weak-reject papers to resubmit.');
    return;
  }

  if (!window.confirm(`Resubmit ${weakRejectPaperIds.length} weak-reject paper${weakRejectPaperIds.length === 1 ? '' : 's'}? Other decisions will stay saved.`)) {
    return;
  }

  weakRejectPaperIds.forEach((paperId) => {
    delete state.decisions[paperId];
  });

  const weakRejectIdSet = new Set(weakRejectPaperIds);
  state.undoStack = state.undoStack.filter((paperId) => !weakRejectIdSet.has(paperId));
  saveDecisions();
  scheduleDecisionSync();

  render();
  flashStatus(
    `Resubmitted ${weakRejectPaperIds.length} weak-reject paper${weakRejectPaperIds.length === 1 ? '' : 's'}.`,
  );
}

function render() {
  const remainingPapers = getRemainingPapers();
  const currentPaper = remainingPapers[0] || null;
  const nextPaper = remainingPapers[1] || null;
  const total = state.papers.length;
  const reviewedCount = total - remainingPapers.length;
  const totalCounts = getDecisionCounts();
  const activeSourcePeriod = getActiveSourcePeriod();
  const activePapers = getPapersForSourcePeriod(activeSourcePeriod);
  const activeCounts = getDecisionCounts(activeSourcePeriod);
  const waitingForOlderPapers = !currentPaper && canLoadOlderPapers();

  let progressTotal = total;
  let progressReviewed = reviewedCount;
  if (activeSourcePeriod) {
    progressTotal = activePapers.length;
    progressReviewed = activePapers.reduce((n, paper) => n + (state.decisions[paper.id] ? 1 : 0), 0);
  }
  elements.progressFill.style.width = `${progressTotal ? (progressReviewed / progressTotal) * 100 : 0}%`;

  updateSourceLabel();

  renderStats(activeCounts);
  elements.undoButton.disabled = !reviewedCount;
  elements.exportButton.disabled = !reviewedCount;
  elements.resetButton.disabled = !totalCounts.weakReject;

  if (!currentPaper) {
    closeAbstractModal();
  }

  elements.currentCard.classList.toggle('hidden', !currentPaper);
  elements.nextCard.classList.toggle('hidden', !currentPaper);
  elements.cardStack.classList.toggle('hidden', !currentPaper);
  elements.emptyState.classList.toggle('hidden', Boolean(currentPaper) || waitingForOlderPapers);

  if (currentPaper) {
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
  updateAbstractModalContent(paper);
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

function getRemainingPapers() {
  return state.papers.filter((paper) => !state.decisions[paper.id]);
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
  return sourcePeriod
    ? state.papers.filter((paper) => paper.sourcePeriod === sourcePeriod)
    : state.papers;
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
  const count = getPapersForSourcePeriod(activeSourcePeriod).length || state.papers.length;

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
