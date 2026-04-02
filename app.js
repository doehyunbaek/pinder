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

const state = {
  sourceUrl: '',
  papers: [],
  decisions: loadDecisions(),
  settings: loadSettings(),
  auth: createInitialAuthState(),
  settingsOpen: false,
  undoStack: [],
  drag: null,
  animating: false,
  statusTimer: null,
};

const elements = {
  statusPanel: document.getElementById('statusPanel'),
  sourceLabel: document.getElementById('sourceLabel'),
  settingsButton: document.getElementById('settingsButton'),
  settingsMenu: document.getElementById('settingsMenu'),
  showButtonsToggle: document.getElementById('showButtonsToggle'),
  authStatus: document.getElementById('authStatus'),
  syncStatus: document.getElementById('syncStatus'),
  signInButton: document.getElementById('signInButton'),
  signOutButton: document.getElementById('signOutButton'),
  progressFill: document.getElementById('progressFill'),
  cardStack: document.getElementById('cardStack'),
  currentCard: document.getElementById('currentCard'),
  nextCard: document.getElementById('nextCard'),
  decisionBadge: document.getElementById('decisionBadge'),
  paperId: document.getElementById('paperId'),
  absLink: document.getElementById('absLink'),
  pdfLink: document.getElementById('pdfLink'),
  paperTitle: document.getElementById('paperTitle'),
  paperAuthors: document.getElementById('paperAuthors'),
  paperAbstract: document.getElementById('paperAbstract'),
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

init();

async function init() {
  const missingRequirements = getMissingDomRequirements();
  if (missingRequirements.length) {
    const message = `Pinder assets are out of sync. This usually means GitHub Pages or your browser cached an older app.js or index.html. Hard refresh the page and try again. Missing: ${missingRequirements.join(', ')}`;
    console.error(message);
    document.body.innerHTML = `<main class="app-shell"><div class="status-panel">${message}</div></main>`;
    return;
  }

  applySettings();
  bindEvents();
  initializeCloudSync();
  showStatus('Loading papers…');

  try {
    const response = await fetch('./papers.json', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Unable to load papers.json (${response.status})`);
    }

    const payload = await response.json();
    state.sourceUrl = payload.sourceUrl || '';
    state.papers = Array.isArray(payload) ? payload : payload.papers || [];
    elements.sourceLabel.textContent = formatSourceLabel(state.sourceUrl, state.papers.length);

    if (!state.papers.length) {
      throw new Error('papers.json did not contain any papers.');
    }

    hideStatus();
    render();
  } catch (error) {
    console.error(error);
    showStatus(
      'Could not load papers.json. If you are previewing locally, use a static server or deploy to GitHub Pages.',
      true,
    );
    elements.progressFill.style.width = '0%';
    elements.currentCard.classList.add('hidden');
    elements.nextCard.classList.add('hidden');
  }
}

function getMissingDomRequirements() {
  const requiredKeys = [
    'statusPanel',
    'sourceLabel',
    'settingsButton',
    'settingsMenu',
    'showButtonsToggle',
    'authStatus',
    'syncStatus',
    'signInButton',
    'signOutButton',
    'progressFill',
    'cardStack',
    'currentCard',
    'nextCard',
    'decisionBadge',
    'paperId',
    'absLink',
    'pdfLink',
    'paperTitle',
    'paperAuthors',
    'paperAbstract',
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

function createInitialAuthState() {
  return {
    configured: false,
    busy: false,
    syncInProgress: false,
    syncMessage: '',
    error: '',
    user: null,
    accessToken: '',
    tokenExpiresAt: 0,
    tokenClient: null,
    sheetId: '',
  };
}

function normalizeSettings(rawSettings = {}) {
  return {
    showActionButtons: rawSettings.showActionButtons !== false,
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

function getGoogleConfig() {
  const config = window.PINDER_GOOGLE_CONFIG || {};

  return {
    clientId: config.clientId || '',
    sheetTitle: config.sheetTitle || 'Pinder Sync',
    settingsSheetTitle: config.settingsSheetTitle || 'settings',
    scopes: config.scopes || [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  };
}

function initializeCloudSync() {
  updateAuthUi();

  const config = getGoogleConfig();
  if (!config.clientId) {
    state.auth.error = 'Google Sheets sync is not configured for this copy of Pinder yet.';
    updateAuthUi();
    return;
  }

  if (!window.google?.accounts?.oauth2?.initTokenClient) {
    state.auth.error = 'Google Identity Services could not be loaded, so Sheets sync is unavailable.';
    updateAuthUi();
    return;
  }

  try {
    state.auth.configured = true;
    state.auth.error = '';
    state.auth.syncMessage = 'Not signed in. Sign in with Google to sync settings to your own sheet.';
    state.auth.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: config.scopes.join(' '),
      callback: () => {},
      error_callback: () => {},
    });
    updateAuthUi();
    attemptSilentSignIn();
  } catch (error) {
    handleCloudSyncError(error);
  }
}

async function attemptSilentSignIn() {
  try {
    await ensureValidAccessToken({ interactive: false });
    await loadGoogleProfile();
    await syncSettingsFromCloud({ interactive: false });
  } catch (error) {
    state.auth.busy = false;
    state.auth.syncInProgress = false;
    state.auth.error = '';
    state.auth.user = null;
    state.auth.accessToken = '';
    state.auth.tokenExpiresAt = 0;
    state.auth.sheetId = '';
    state.auth.syncMessage = 'Settings stay on this device until you sign in with Google.';
    updateAuthUi();
  }
}

function updateAuthUi() {
  if (!state.auth.configured) {
    elements.authStatus.textContent = 'Google Sheets sync unavailable';
    elements.syncStatus.textContent = state.auth.error || 'Add Google OAuth config to enable login and sheet sync.';
    elements.signInButton.textContent = 'Google Sheets sync unavailable';
    elements.signInButton.disabled = true;
    elements.signInButton.classList.remove('hidden');
    elements.signOutButton.classList.add('hidden');
    return;
  }

  if (state.auth.user) {
    const identity = state.auth.user.name || state.auth.user.email || 'Google user';
    elements.authStatus.textContent = `Signed in as ${identity}`;
    elements.signInButton.classList.add('hidden');
    elements.signOutButton.classList.remove('hidden');
    elements.signOutButton.disabled = state.auth.busy;
  } else {
    elements.authStatus.textContent = 'Not signed in';
    elements.signInButton.classList.remove('hidden');
    elements.signOutButton.classList.add('hidden');
    elements.signInButton.textContent = state.auth.busy ? 'Opening Google…' : 'Sign in with Google';
    elements.signInButton.disabled = state.auth.busy;
  }

  if (state.auth.error) {
    elements.syncStatus.textContent = state.auth.error;
  } else if (state.auth.syncInProgress) {
    elements.syncStatus.textContent = 'Syncing settings with Google Sheets…';
  } else {
    elements.syncStatus.textContent = state.auth.syncMessage || 'Settings will sync to your Google Sheet.';
  }
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

function requestGoogleAccessToken({ interactive }) {
  return new Promise((resolve, reject) => {
    if (!state.auth.tokenClient) {
      reject(new Error('Google token client is not ready.'));
      return;
    }

    state.auth.tokenClient.callback = (response) => {
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    };

    state.auth.tokenClient.error_callback = (error) => {
      reject(error instanceof Error ? error : new Error(error?.type || 'Google login failed.'));
    };

    state.auth.tokenClient.requestAccessToken({
      prompt: interactive ? 'consent' : '',
    });
  });
}

async function ensureValidAccessToken({ interactive }) {
  if (state.auth.accessToken && Date.now() < state.auth.tokenExpiresAt - 60_000) {
    return state.auth.accessToken;
  }

  const response = await requestGoogleAccessToken({ interactive });
  state.auth.accessToken = response.access_token;
  state.auth.tokenExpiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
  return state.auth.accessToken;
}

async function loadGoogleProfile() {
  const accessToken = await ensureValidAccessToken({ interactive: false });
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Could not load Google profile (${response.status})`);
  }

  const profile = await response.json();
  state.auth.user = {
    id: profile.sub,
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
  };
  updateAuthUi();
  return state.auth.user;
}

async function googleApiFetch(url, options = {}) {
  const accessToken = await ensureValidAccessToken({ interactive: Boolean(options.interactive) });
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API ${response.status}: ${errorText}`);
  }

  return response;
}

async function ensureSyncSpreadsheet({ interactive = false } = {}) {
  if (state.auth.sheetId) {
    return state.auth.sheetId;
  }

  const query = encodeURIComponent(
    "trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and appProperties has { key='pinderApp' and value='settings' }",
  );
  const searchResponse = await googleApiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&pageSize=10&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`,
    { interactive },
  );
  const searchPayload = await searchResponse.json();
  const existingFile = searchPayload.files?.[0];

  if (existingFile?.id) {
    state.auth.sheetId = existingFile.id;
    return state.auth.sheetId;
  }

  const config = getGoogleConfig();
  const createResponse = await googleApiFetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    interactive: true,
    body: JSON.stringify({
      properties: {
        title: config.sheetTitle,
      },
      sheets: [
        {
          properties: {
            title: config.settingsSheetTitle,
          },
        },
      ],
    }),
  });
  const createPayload = await createResponse.json();
  state.auth.sheetId = createPayload.spreadsheetId;

  await googleApiFetch(`https://www.googleapis.com/drive/v3/files/${state.auth.sheetId}`, {
    method: 'PATCH',
    interactive: true,
    body: JSON.stringify({
      appProperties: {
        pinderApp: 'settings',
      },
    }),
  });

  return state.auth.sheetId;
}

async function ensureSettingsSheetTab(spreadsheetId, { interactive = false } = {}) {
  const config = getGoogleConfig();
  const response = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
    { interactive },
  );
  const payload = await response.json();
  const hasSettingsSheet = payload.sheets?.some(
    (sheet) => sheet.properties?.title === config.settingsSheetTitle,
  );

  if (hasSettingsSheet) {
    return;
  }

  await googleApiFetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    interactive,
    body: JSON.stringify({
      requests: [
        {
          addSheet: {
            properties: {
              title: config.settingsSheetTitle,
            },
          },
        },
      ],
    }),
  });
}

function parseRemoteSettings(values) {
  const parsed = {};

  values.slice(1).forEach((row) => {
    const [key, value, updatedAt] = row;
    if (!key) {
      return;
    }

    if (key === 'showActionButtons') {
      parsed.showActionButtons = String(value).toLowerCase() !== 'false';
      parsed.updatedAt = updatedAt || parsed.updatedAt;
    }
  });

  return Object.keys(parsed).length ? normalizeSettings(parsed) : null;
}

async function readRemoteSettings({ interactive = false } = {}) {
  const spreadsheetId = await ensureSyncSpreadsheet({ interactive });
  await ensureSettingsSheetTab(spreadsheetId, { interactive });
  const range = encodeURIComponent(`${getGoogleConfig().settingsSheetTitle}!A:C`);
  const response = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
    { interactive },
  );
  const payload = await response.json();
  return parseRemoteSettings(payload.values || []);
}

async function writeRemoteSettings({ interactive = false } = {}) {
  const spreadsheetId = await ensureSyncSpreadsheet({ interactive });
  await ensureSettingsSheetTab(spreadsheetId, { interactive });
  const settings = normalizeSettings(state.settings);
  const rangeName = `${getGoogleConfig().settingsSheetTitle}!A1:C2`;
  const range = encodeURIComponent(rangeName);

  await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: 'PUT',
      interactive,
      body: JSON.stringify({
        range: rangeName,
        majorDimension: 'ROWS',
        values: [
          ['key', 'value', 'updatedAt'],
          ['showActionButtons', settings.showActionButtons ? 'true' : 'false', settings.updatedAt || ''],
        ],
      }),
    },
  );
}

async function syncSettingsFromCloud({ interactive = false } = {}) {
  if (!state.auth.user) {
    return;
  }

  state.auth.syncInProgress = true;
  state.auth.syncMessage = 'Checking Google Sheet…';
  updateAuthUi();

  try {
    const remoteSettings = await readRemoteSettings({ interactive });
    const localSettings = normalizeSettings(state.settings);

    if (remoteSettings && isRemoteSettingsNewer(remoteSettings.updatedAt, localSettings.updatedAt)) {
      state.settings = remoteSettings;
      saveSettings();
      applySettings();
      state.auth.syncMessage = 'Settings downloaded from Google Sheets.';
      state.auth.syncInProgress = false;
      updateAuthUi();
      return;
    }

    await syncSettingsToCloud({ interactive });
  } catch (error) {
    handleCloudSyncError(error);
  }
}

async function syncSettingsToCloud({ interactive = false } = {}) {
  if (!state.auth.user) {
    return;
  }

  if (!state.settings.updatedAt) {
    state.settings.updatedAt = new Date().toISOString();
    saveSettings();
  }

  state.auth.syncInProgress = true;
  updateAuthUi();

  try {
    await writeRemoteSettings({ interactive });
    state.auth.error = '';
    state.auth.syncMessage = 'Settings synced to Google Sheets.';
  } catch (error) {
    handleCloudSyncError(error);
    return;
  }

  state.auth.syncInProgress = false;
  updateAuthUi();
}

async function signInWithGoogle() {
  if (!state.auth.configured) {
    return;
  }

  state.auth.busy = true;
  state.auth.error = '';
  state.auth.syncMessage = 'Opening Google sign-in…';
  updateAuthUi();

  try {
    await ensureValidAccessToken({ interactive: true });
    await loadGoogleProfile();
    await syncSettingsFromCloud({ interactive: true });
    closeSettingsMenu();
    flashStatus('Signed in with Google Sheets sync.');
  } catch (error) {
    handleCloudSyncError(error);
    return;
  }

  state.auth.busy = false;
  updateAuthUi();
}

async function signOutFromGoogle() {
  if (!state.auth.configured) {
    return;
  }

  state.auth.busy = true;
  updateAuthUi();

  try {
    if (state.auth.accessToken) {
      await new Promise((resolve) => {
        window.google.accounts.oauth2.revoke(state.auth.accessToken, () => resolve());
      });
    }
  } catch (error) {
    handleCloudSyncError(error);
    return;
  }

  state.auth.busy = false;
  state.auth.user = null;
  state.auth.accessToken = '';
  state.auth.tokenExpiresAt = 0;
  state.auth.sheetId = '';
  state.auth.error = '';
  state.auth.syncInProgress = false;
  state.auth.syncMessage = 'Signed out. Your settings remain saved on this device.';
  updateAuthUi();
  closeSettingsMenu();
  flashStatus('Signed out from Google Sheets sync.');
}

function handleCloudSyncError(error) {
  console.error(error);
  state.auth.busy = false;
  state.auth.syncInProgress = false;
  state.auth.error = error?.message || 'Google Sheets sync failed.';
  updateAuthUi();
}

function applySettings() {
  const showActionButtons = state.settings.showActionButtons !== false;
  elements.showButtonsToggle.checked = showActionButtons;
  elements.actionGrid.classList.toggle('hidden', !showActionButtons);
}

function openSettingsMenu() {
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

function onShowButtonsToggleChange(event) {
  state.settings.showActionButtons = event.target.checked;
  state.settings.updatedAt = new Date().toISOString();
  saveSettings();
  applySettings();
  closeSettingsMenu();

  if (state.auth.user) {
    syncSettingsToCloud({ interactive: true });
  }

  flashStatus(
    event.target.checked
      ? 'Button controls shown.'
      : 'Button controls hidden. Swipe or use arrow keys to rate papers.',
  );
}

function onDocumentClick(event) {
  if (!state.settingsOpen) {
    return;
  }

  if (!(event.target instanceof Node)) {
    return;
  }

  if (
    elements.settingsMenu.contains(event.target)
    || elements.settingsButton.contains(event.target)
  ) {
    return;
  }

  closeSettingsMenu();
}

function bindEvents() {
  elements.currentCard.addEventListener('pointerdown', onPointerDown);
  elements.currentCard.addEventListener('pointermove', onPointerMove);
  elements.currentCard.addEventListener('pointerup', onPointerUp);
  elements.currentCard.addEventListener('pointercancel', onPointerCancel);

  elements.settingsButton.addEventListener('click', toggleSettingsMenu);
  elements.showButtonsToggle.addEventListener('change', onShowButtonsToggleChange);
  elements.signInButton.addEventListener('click', signInWithGoogle);
  elements.signOutButton.addEventListener('click', signOutFromGoogle);

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
  elements.resetButton.addEventListener('click', resetAllDecisions);

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeyDown);
}

function onKeyDown(event) {
  if (event.key === 'Escape' && state.settingsOpen) {
    closeSettingsMenu();
    return;
  }

  if (state.settingsOpen) {
    return;
  }

  const targetTag = document.activeElement?.tagName;
  if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') {
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

  if (event.key.toLowerCase() === 'u') {
    event.preventDefault();
    undoLastDecision();
  }
}

function onPointerDown(event) {
  if (state.animating || !getCurrentPaper()) {
    return;
  }

  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }

  if (event.target instanceof Element && event.target.closest('a, button')) {
    return;
  }

  state.drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dx: 0,
    dy: 0,
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
  if (!decision) {
    resetCardTransform();
    updateDecisionBadge(null);
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
  };

  state.undoStack.push(paper.id);
  saveDecisions();
}

function undoLastDecision() {
  const undoId = state.undoStack.pop() || findMostRecentDecisionId();
  if (!undoId) {
    flashStatus('Nothing to undo.');
    return;
  }

  delete state.decisions[undoId];
  saveDecisions();
  render();
  flashStatus('Undid the last review.');
}

function findMostRecentDecisionId() {
  return Object.entries(state.decisions)
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

function resetAllDecisions() {
  if (!window.confirm('Clear all saved reviews on this device?')) {
    return;
  }

  state.decisions = {};
  state.undoStack = [];
  saveDecisions();
  render();
  flashStatus('Cleared all reviews.');
}

function render() {
  const remainingPapers = getRemainingPapers();
  const currentPaper = remainingPapers[0] || null;
  const nextPaper = remainingPapers[1] || null;
  const total = state.papers.length;
  const reviewedCount = total - remainingPapers.length;
  const counts = getDecisionCounts();

  elements.progressFill.style.width = `${total ? (reviewedCount / total) * 100 : 0}%`;

  elements.stats.textContent = `Accept ${counts.accept} · Weak accept ${counts.weakAccept} · Weak reject ${counts.weakReject} · Reject ${counts.reject}`;
  elements.undoButton.disabled = !reviewedCount;
  elements.exportButton.disabled = !reviewedCount;

  elements.currentCard.classList.toggle('hidden', !currentPaper);
  elements.nextCard.classList.toggle('hidden', !currentPaper);
  elements.cardStack.classList.toggle('hidden', !currentPaper);
  elements.emptyState.classList.toggle('hidden', Boolean(currentPaper));

  if (currentPaper) {
    renderCurrentPaper(currentPaper);
    renderNextPaper(nextPaper);
  } else {
    renderSummary(counts, total);
  }
}

function renderCurrentPaper(paper) {
  elements.paperId.textContent = paper.id;
  elements.paperTitle.textContent = paper.title;
  elements.paperAuthors.textContent = paper.authorsText || 'Unknown authors';
  elements.paperAbstract.textContent = paper.abstract || 'No abstract available.';
  elements.absLink.href = paper.absUrl;
  elements.pdfLink.href = paper.pdfUrl;
}

function renderNextPaper(paper) {
  if (!paper) {
    elements.nextTitle.textContent = 'You are almost done.';
    elements.nextAuthors.textContent = 'No papers after this one.';
    return;
  }

  elements.nextTitle.textContent = paper.title;
  elements.nextAuthors.textContent = paper.authorsText || 'Unknown authors';
}

function renderSummary(counts, total) {
  elements.emptySummary.textContent = `You reviewed ${total} papers from this batch.`;
  elements.summaryGrid.innerHTML = [
    summaryCardMarkup('Accept', counts.accept),
    summaryCardMarkup('Weak accept', counts.weakAccept),
    summaryCardMarkup('Weak reject', counts.weakReject),
    summaryCardMarkup('Reject', counts.reject),
  ].join('');
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
      absUrl: paper.absUrl,
      pdfUrl: paper.pdfUrl,
      decision: state.decisions[paper.id].decision,
      decidedAt: state.decisions[paper.id].decidedAt,
    }))
    .sort((a, b) => new Date(a.decidedAt) - new Date(b.decidedAt));
}

function getDecisionCounts() {
  const counts = {
    accept: 0,
    weakAccept: 0,
    weakReject: 0,
    reject: 0,
  };

  Object.values(state.decisions).forEach((entry) => {
    if (counts[entry.decision] !== undefined) {
      counts[entry.decision] += 1;
    }
  });

  return counts;
}

function formatSourceLabel(sourceUrl, count) {
  const match = sourceUrl.match(/list\/([^/]+)\/([^?]+)/i);
  if (!match) {
    return `arXiv · ${count} papers`;
  }

  return `arXiv · ${match[1]} · ${match[2]} · ${count} papers`;
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
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
  } catch (error) {
    console.warn('Could not read saved decisions.', error);
    return {};
  }
}

function saveDecisions() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.decisions));
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
