(() => {
  const AUTH_STORAGE_KEY = 'pinder-google-auth-session-v1';

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
      grantedScopes: [],
      tokenClient: null,
      sheetId: '',
    };
  }

  function parseGrantedScopes(scopeValue) {
    if (Array.isArray(scopeValue)) {
      return scopeValue.map((scope) => String(scope).trim()).filter(Boolean);
    }

    return String(scopeValue || '')
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
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

  function createController(deps) {
    const authState = createInitialAuthState();

    const {
      elements,
      normalizeSettings,
      normalizeDecisionMap,
      mergeDecisionMaps,
      getDecisionAbsUrl,
      getDecisionSyncTarget,
      getDecisionsForSyncTarget,
      getSettings,
      setSettings,
      saveSettings,
      applySettings,
      getDecisions,
      setDecisions,
      saveDecisions,
      renderIfReady,
      closeSettingsMenu,
      flashStatus,
      clearDecisionSyncTimer,
    } = deps;

    function getGoogleConfig() {
      const config = window.PINDER_GOOGLE_CONFIG || {};

      return {
        clientId: config.clientId || '',
        sheetTitle: config.sheetTitle || 'Pinder Sync',
        settingsSheetTitle: config.settingsSheetTitle || 'settings',
        arxivSheetTitle: config.arxivSheetTitle || 'arxiv',
        icseSheetTitle: config.icseSheetTitle || 'icse',
        legacyDecisionsSheetTitle: config.decisionsSheetTitle || 'decisions',
        scopes: config.scopes || [
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/userinfo.email',
          'https://www.googleapis.com/auth/userinfo.profile',
        ],
      };
    }

    function hasRequiredScopes(grantedScopes = []) {
      const grantedScopeSet = new Set(grantedScopes);
      return getGoogleConfig().scopes.every((scope) => grantedScopeSet.has(scope));
    }

    function normalizeDecisionSyncTarget(syncTarget) {
      return syncTarget === 'icse' ? 'icse' : 'arxiv';
    }

    function getDecisionSheetTitle(syncTarget) {
      const config = getGoogleConfig();
      return normalizeDecisionSyncTarget(syncTarget) === 'icse'
        ? config.icseSheetTitle
        : config.arxivSheetTitle;
    }

    function getDecisionSheetLabel(syncTarget) {
      return normalizeDecisionSyncTarget(syncTarget) === 'icse' ? 'ICSE' : 'arXiv';
    }

    function loadCachedAuthSession() {
      try {
        return JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || 'null');
      } catch (error) {
        console.warn('Could not read cached Google auth session.', error);
        return null;
      }
    }

    function saveCachedAuthSession() {
      try {
        if (!authState.user || !authState.accessToken || !authState.tokenExpiresAt) {
          window.localStorage.removeItem(AUTH_STORAGE_KEY);
          return;
        }

        window.localStorage.setItem(
          AUTH_STORAGE_KEY,
          JSON.stringify({
            user: authState.user,
            accessToken: authState.accessToken,
            tokenExpiresAt: authState.tokenExpiresAt,
            grantedScopes: authState.grantedScopes,
            sheetId: authState.sheetId,
          }),
        );
      } catch (error) {
        console.warn('Could not cache Google auth session.', error);
      }
    }

    function clearCachedAuthSession() {
      try {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      } catch (error) {
        console.warn('Could not clear cached Google auth session.', error);
      }
    }

    function restoreCachedAuthSession() {
      const cachedSession = loadCachedAuthSession();
      if (!cachedSession) {
        authState.syncMessage = 'Settings and review outcomes stay on this device until you sign in with Google.';
        return false;
      }

      if (!cachedSession.accessToken || Date.now() >= Number(cachedSession.tokenExpiresAt || 0) - 60_000) {
        clearCachedAuthSession();
        authState.syncMessage = 'Google session expired. Tap Sign in to reconnect Sheets sync.';
        return false;
      }

      const grantedScopes = parseGrantedScopes(cachedSession.grantedScopes);
      if (!hasRequiredScopes(grantedScopes)) {
        clearCachedAuthSession();
        authState.syncMessage = 'Google permissions changed. Tap Sign in to grant Drive and Sheets access again.';
        return false;
      }

      authState.user = cachedSession.user || null;
      authState.accessToken = cachedSession.accessToken;
      authState.tokenExpiresAt = Number(cachedSession.tokenExpiresAt || 0);
      authState.grantedScopes = grantedScopes;
      authState.sheetId = cachedSession.sheetId || '';
      authState.syncMessage = 'Using cached Google session from this browser.';
      return true;
    }

    function updateAuthUi() {
      if (!authState.configured) {
        elements.authStatus.textContent = 'Google Sheets sync unavailable';
        elements.syncStatus.textContent = authState.error || 'Add Google OAuth config to enable login and sheet sync.';
        elements.topAuthButton.textContent = 'Sync unavailable';
        elements.topAuthButton.disabled = true;
        elements.topAuthButton.classList.remove('connected');
        return;
      }

      elements.topAuthButton.disabled = authState.busy;

      if (authState.user) {
        const identity = authState.user.name || authState.user.email || 'Google user';
        elements.authStatus.textContent = `Signed in as ${identity}`;
        elements.topAuthButton.textContent = authState.busy ? 'Signing out…' : 'Sign out';
        elements.topAuthButton.classList.add('connected');
      } else {
        elements.authStatus.textContent = 'Not signed in';
        elements.topAuthButton.textContent = authState.busy ? 'Opening…' : 'Sign in';
        elements.topAuthButton.classList.remove('connected');
      }

      if (authState.error) {
        elements.syncStatus.textContent = authState.error;
      } else if (authState.syncInProgress) {
        elements.syncStatus.textContent = 'Syncing settings and review outcomes with Google Sheets…';
      } else {
        elements.syncStatus.textContent = authState.syncMessage || 'Settings and review outcomes will sync to your Google Sheet.';
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
        if (!authState.tokenClient) {
          reject(new Error('Google token client is not ready.'));
          return;
        }

        authState.tokenClient.callback = (response) => {
          if (response?.error) {
            reject(new Error(response.error));
            return;
          }
          resolve(response);
        };

        authState.tokenClient.error_callback = (error) => {
          reject(error instanceof Error ? error : new Error(error?.type || 'Google login failed.'));
        };

        authState.tokenClient.requestAccessToken({
          prompt: interactive ? 'consent' : '',
        });
      });
    }

    async function ensureValidAccessToken({ interactive, force = false }) {
      const hasFreshToken = authState.accessToken && Date.now() < authState.tokenExpiresAt - 60_000;
      const tokenHasRequiredScopes = hasRequiredScopes(authState.grantedScopes);

      if (!force && hasFreshToken && tokenHasRequiredScopes) {
        return authState.accessToken;
      }

      if (!interactive) {
        clearCachedAuthSession();
        authState.user = null;
        authState.accessToken = '';
        authState.tokenExpiresAt = 0;
        authState.grantedScopes = [];
        authState.sheetId = '';
        throw new Error(
          hasFreshToken && !tokenHasRequiredScopes
            ? 'Google token is missing Drive or Sheets access. Tap Sign in to grant permissions again.'
            : 'Google session expired. Tap Sign in to reconnect Sheets sync.',
        );
      }

      const response = await requestGoogleAccessToken({ interactive: true });
      authState.accessToken = response.access_token;
      authState.tokenExpiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
      authState.grantedScopes = parseGrantedScopes(response.scope || getGoogleConfig().scopes.join(' '));
      saveCachedAuthSession();
      return authState.accessToken;
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
      authState.user = {
        id: profile.sub,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
      };
      saveCachedAuthSession();
      updateAuthUi();
      return authState.user;
    }

    async function googleApiFetch(url, options = {}) {
      const interactive = Boolean(options.interactive);
      const accessToken = await ensureValidAccessToken({ interactive });
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

        if (response.status === 403 && errorText.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
          clearCachedAuthSession();
          authState.accessToken = '';
          authState.tokenExpiresAt = 0;
          authState.grantedScopes = [];

          if (interactive && !options._retriedAfterScopeUpgrade) {
            await ensureValidAccessToken({ interactive: true, force: true });
            return googleApiFetch(url, {
              ...options,
              _retriedAfterScopeUpgrade: true,
            });
          }

          throw new Error('Google token is missing Drive or Sheets access. Tap Sign in to grant permissions again.');
        }

        throw new Error(`Google API ${response.status}: ${errorText}`);
      }

      return response;
    }

    async function ensureSyncSpreadsheet({ interactive = false } = {}) {
      if (authState.sheetId) {
        return authState.sheetId;
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
        authState.sheetId = existingFile.id;
        saveCachedAuthSession();
        return authState.sheetId;
      }

      const config = getGoogleConfig();
      const createResponse = await googleApiFetch('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        interactive,
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
            {
              properties: {
                title: config.arxivSheetTitle,
              },
            },
            {
              properties: {
                title: config.icseSheetTitle,
              },
            },
          ],
        }),
      });
      const createPayload = await createResponse.json();
      authState.sheetId = createPayload.spreadsheetId;
      saveCachedAuthSession();

      await googleApiFetch(`https://www.googleapis.com/drive/v3/files/${authState.sheetId}`, {
        method: 'PATCH',
        interactive,
        body: JSON.stringify({
          appProperties: {
            pinderApp: 'settings',
          },
        }),
      });

      return authState.sheetId;
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

    async function ensureDecisionSheetTab(spreadsheetId, sheetTitle, { interactive = false } = {}) {
      const response = await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`,
        { interactive },
      );
      const payload = await response.json();
      const hasDecisionSheet = payload.sheets?.some(
        (sheet) => sheet.properties?.title === sheetTitle,
      );

      if (hasDecisionSheet) {
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
                  title: sheetTitle,
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

        if (key === 'showAuthors') {
          parsed.showAuthors = String(value).toLowerCase() !== 'false';
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
      const settings = normalizeSettings(getSettings());
      const values = [
        ['key', 'value', 'updatedAt'],
        ['showActionButtons', settings.showActionButtons ? 'true' : 'false', settings.updatedAt || ''],
        ['showAuthors', settings.showAuthors ? 'true' : 'false', settings.updatedAt || ''],
      ];
      const rangeName = `${getGoogleConfig().settingsSheetTitle}!A1:C${values.length}`;
      const range = encodeURIComponent(rangeName);

      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
        {
          method: 'PUT',
          interactive,
          body: JSON.stringify({
            range: rangeName,
            majorDimension: 'ROWS',
            values,
          }),
        },
      );
    }

    function parseRemoteDecisions(values, syncTarget) {
      const parsed = {};
      const normalizedSyncTarget = normalizeDecisionSyncTarget(syncTarget);

      values.slice(1).forEach((row) => {
        const [absUrl, decision, decidedAt, paperIdFromSheet] = row;
        const paperId = paperIdFromSheet || extractArxivIdFromUrl(absUrl);
        if (!paperId || !decision) {
          return;
        }

        parsed[paperId] = {
          absUrl,
          decision,
          decidedAt,
          sourceType: normalizedSyncTarget,
        };
      });

      return normalizeDecisionMap(parsed);
    }

    async function readDecisionSheetValues(spreadsheetId, sheetTitle, { interactive = false } = {}) {
      const range = encodeURIComponent(`${sheetTitle}!A:D`);
      const response = await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`,
        { interactive },
      );
      const payload = await response.json();
      return payload.values || [];
    }

    async function readRemoteDecisions({ interactive = false, syncTarget } = {}) {
      const normalizedSyncTarget = normalizeDecisionSyncTarget(syncTarget);
      const spreadsheetId = await ensureSyncSpreadsheet({ interactive });
      const decisionSheetTitle = getDecisionSheetTitle(normalizedSyncTarget);
      await ensureDecisionSheetTab(spreadsheetId, decisionSheetTitle, { interactive });

      const parsedDecisionMaps = [
        parseRemoteDecisions(
          await readDecisionSheetValues(spreadsheetId, decisionSheetTitle, { interactive }),
          normalizedSyncTarget,
        ),
      ];

      if (normalizedSyncTarget === 'arxiv') {
        const legacySheetTitle = getGoogleConfig().legacyDecisionsSheetTitle;
        if (legacySheetTitle && legacySheetTitle !== decisionSheetTitle) {
          try {
            const legacyValues = await readDecisionSheetValues(spreadsheetId, legacySheetTitle, { interactive });
            parsedDecisionMaps.push(parseRemoteDecisions(legacyValues, 'arxiv'));
          } catch (error) {
            // Ignore missing legacy tab. Old users may not have it, and new users should not need it.
          }
        }
      }

      return parsedDecisionMaps.reduce(
        (mergedDecisions, decisionMap) => mergeDecisionMaps(mergedDecisions, decisionMap),
        {},
      );
    }

    async function writeRemoteDecisions({ interactive = false, syncTarget } = {}) {
      const normalizedSyncTarget = normalizeDecisionSyncTarget(syncTarget);
      const spreadsheetId = await ensureSyncSpreadsheet({ interactive });
      const decisionSheetTitle = getDecisionSheetTitle(normalizedSyncTarget);
      await ensureDecisionSheetTab(spreadsheetId, decisionSheetTitle, { interactive });
      const clearRangeName = `${decisionSheetTitle}!A:D`;
      const clearRange = encodeURIComponent(clearRangeName);

      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${clearRange}:clear`,
        {
          method: 'POST',
          interactive,
          body: JSON.stringify({}),
        },
      );

      const rows = [
        ['absUrl', 'decision', 'decidedAt', 'paperId'],
        ...Object.entries(normalizeDecisionMap(getDecisionsForSyncTarget(normalizedSyncTarget)))
          .sort(([, leftEntry], [, rightEntry]) => new Date(leftEntry.decidedAt) - new Date(rightEntry.decidedAt))
          .map(([paperId, decisionEntry]) => [
            getDecisionAbsUrl(paperId, decisionEntry),
            decisionEntry.decision,
            decisionEntry.decidedAt || '',
            paperId,
          ]),
      ];

      const rangeName = `${decisionSheetTitle}!A1:D${rows.length}`;
      const range = encodeURIComponent(rangeName);
      await googleApiFetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
        {
          method: 'PUT',
          interactive,
          body: JSON.stringify({
            range: rangeName,
            majorDimension: 'ROWS',
            values: rows,
          }),
        },
      );
    }

    function handleCloudSyncError(error) {
      console.error(error);
      const message = error?.message || 'Google Sheets sync failed.';

      if (message.includes('session expired') || message.includes('missing Drive or Sheets access')) {
        clearCachedAuthSession();
        authState.user = null;
        authState.accessToken = '';
        authState.tokenExpiresAt = 0;
        authState.grantedScopes = [];
        authState.sheetId = '';
      }

      authState.busy = false;
      authState.syncInProgress = false;
      authState.error = message;
      updateAuthUi();
    }

    async function syncSettingsFromCloud({ interactive = false } = {}) {
      if (!authState.user) {
        return false;
      }

      authState.syncInProgress = true;
      authState.syncMessage = 'Checking Google Sheet…';
      updateAuthUi();

      try {
        const remoteSettings = await readRemoteSettings({ interactive });
        const localSettings = normalizeSettings(getSettings());

        if (remoteSettings && isRemoteSettingsNewer(remoteSettings.updatedAt, localSettings.updatedAt)) {
          setSettings(remoteSettings);
          saveSettings();
          applySettings();
          authState.syncMessage = 'Settings downloaded from Google Sheets.';
          authState.syncInProgress = false;
          updateAuthUi();
          return true;
        }

        await syncSettingsToCloud({ interactive });
        return true;
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }
    }

    async function syncSettingsToCloud({ interactive = false } = {}) {
      if (!authState.user) {
        return false;
      }

      const settings = getSettings();
      if (!settings.updatedAt) {
        settings.updatedAt = new Date().toISOString();
        saveSettings();
      }

      authState.syncInProgress = true;
      updateAuthUi();

      try {
        await writeRemoteSettings({ interactive });
        authState.error = '';
        authState.syncMessage = 'Settings synced to Google Sheets.';
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }

      authState.syncInProgress = false;
      updateAuthUi();
      return true;
    }

    async function syncDecisionsFromCloud({ interactive = false } = {}) {
      if (!authState.user) {
        return false;
      }

      const syncTarget = getDecisionSyncTarget();
      const decisionSheetLabel = getDecisionSheetLabel(syncTarget);
      authState.syncInProgress = true;
      authState.syncMessage = `Checking Google Sheet for ${decisionSheetLabel} review outcomes…`;
      updateAuthUi();

      try {
        const remoteDecisions = await readRemoteDecisions({ interactive, syncTarget });
        const mergedDecisions = mergeDecisionMaps(normalizeDecisionMap(getDecisions()), remoteDecisions);
        setDecisions(mergedDecisions);
        saveDecisions();
        renderIfReady();

        await syncDecisionsToCloud({ interactive });
        authState.syncMessage = `Settings and ${decisionSheetLabel} review outcomes synced to Google Sheets.`;
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }

      authState.syncInProgress = false;
      updateAuthUi();
      return true;
    }

    async function syncDecisionsToCloud({ interactive = false } = {}) {
      if (!authState.user) {
        return false;
      }

      const syncTarget = getDecisionSyncTarget();
      const decisionSheetLabel = getDecisionSheetLabel(syncTarget);
      authState.syncInProgress = true;
      updateAuthUi();

      try {
        await writeRemoteDecisions({ interactive, syncTarget });
        authState.error = '';
        authState.syncMessage = `${decisionSheetLabel} review outcomes synced to Google Sheets.`;
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }

      authState.syncInProgress = false;
      updateAuthUi();
      return true;
    }

    async function signInWithGoogle() {
      if (!authState.configured) {
        return;
      }

      authState.busy = true;
      authState.error = '';
      authState.syncMessage = 'Opening Google sign-in…';
      updateAuthUi();

      try {
        await ensureValidAccessToken({ interactive: true });
        await loadGoogleProfile();
        const settingsSynced = await syncSettingsFromCloud({ interactive: true });
        const decisionsSynced = await syncDecisionsFromCloud({ interactive: true });

        if (!settingsSynced || !decisionsSynced) {
          return;
        }

        closeSettingsMenu();
        flashStatus('Signed in with Google Sheets sync.');
      } catch (error) {
        handleCloudSyncError(error);
        return;
      }

      authState.busy = false;
      updateAuthUi();
    }

    async function signOutFromGoogle() {
      if (!authState.configured) {
        return;
      }

      authState.busy = true;
      updateAuthUi();

      try {
        if (authState.accessToken) {
          await new Promise((resolve) => {
            window.google.accounts.oauth2.revoke(authState.accessToken, () => resolve());
          });
        }
      } catch (error) {
        handleCloudSyncError(error);
        return;
      }

      clearDecisionSyncTimer();
      clearCachedAuthSession();
      authState.busy = false;
      authState.user = null;
      authState.accessToken = '';
      authState.tokenExpiresAt = 0;
      authState.grantedScopes = [];
      authState.sheetId = '';
      authState.error = '';
      authState.syncInProgress = false;
      authState.syncMessage = 'Signed out. Your settings and review outcomes remain saved on this device.';
      updateAuthUi();
      closeSettingsMenu();
      flashStatus('Signed out from Google Sheets sync.');
    }

    async function onTopAuthButtonClick() {
      if (!authState.configured) {
        return;
      }

      if (!authState.user) {
        await signInWithGoogle();
        return;
      }

      await signOutFromGoogle();
    }

    function initialize() {
      updateAuthUi();

      const config = getGoogleConfig();
      if (!config.clientId) {
        authState.error = 'Google Sheets sync is not configured for this copy of Pinder yet.';
        updateAuthUi();
        return;
      }

      if (!window.google?.accounts?.oauth2?.initTokenClient) {
        authState.error = 'Google Identity Services could not be loaded, so Sheets sync is unavailable.';
        updateAuthUi();
        return;
      }

      try {
        authState.configured = true;
        authState.error = '';
        authState.syncMessage = 'Not signed in. Tap Sign in to sync settings and review outcomes to your own sheet.';
        authState.tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: config.clientId,
          scope: config.scopes.join(' '),
          callback: () => {},
          error_callback: () => {},
        });

        restoreCachedAuthSession();
        updateAuthUi();

        if (authState.user && authState.accessToken) {
          syncSettingsFromCloud({ interactive: false });
          syncDecisionsFromCloud({ interactive: false });
        }
      } catch (error) {
        handleCloudSyncError(error);
      }
    }

    return {
      initialize,
      isSignedIn: () => Boolean(authState.user),
      onTopAuthButtonClick,
      syncSettingsToCloud,
      syncDecisionsToCloud,
    };
  }

  window.PinderAuth = {
    createController,
  };
})();
