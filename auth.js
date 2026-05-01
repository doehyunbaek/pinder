(() => {
  function createInitialAuthState() {
    return {
      configured: false,
      busy: false,
      syncInProgress: false,
      syncMessage: '',
      error: '',
      user: null,
      firebaseApp: null,
      firebaseAuth: null,
      firestore: null,
      googleProvider: null,
      authReadyPromise: null,
    };
  }

  function getFirebaseAuthErrorMessage(error) {
    const code = String(error?.code || error?.message || '').toLowerCase();

    if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) {
      return 'Google sign-in was closed before it finished.';
    }
    if (code.includes('popup-blocked')) {
      return 'Browser blocked the Google sign-in popup. Allow popups and try again.';
    }
    if (code.includes('unauthorized-domain')) {
      return 'Firebase Authentication is not configured for this domain.';
    }
    if (code.includes('configuration-not-found')) {
      return 'Firebase Authentication is not enabled or Google sign-in is not configured.';
    }
    if (code.includes('permission-denied')) {
      return 'Firestore permission denied. Check your Firestore security rules.';
    }
    if (code.includes('unavailable')) {
      return 'Firestore is temporarily unavailable. Try again shortly.';
    }

    return error?.message || 'Firebase sync failed.';
  }

  function getFirebaseUserProfile(firebaseUser) {
    if (!firebaseUser) {
      return null;
    }

    return {
      id: firebaseUser.uid,
      email: firebaseUser.email || '',
      name: firebaseUser.displayName || firebaseUser.email || '',
      picture: firebaseUser.photoURL || '',
    };
  }

  function createController(deps) {
    const authState = createInitialAuthState();

    const {
      elements,
      normalizeSettings,
      normalizeDecisionMap,
      mergeDecisionMaps,
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
      getDecisionSyncTarget,
      getDecisionsForSyncTarget,
    } = deps;

    function getConfig() {
      return window.PINDER_GOOGLE_CONFIG || {};
    }

    function normalizeDecisionSyncTarget(syncTarget) {
      return ['icse', 'fse'].includes(syncTarget) ? syncTarget : 'arxiv';
    }

    function getDecisionSheetLabel(syncTarget) {
      const normalizedSyncTarget = normalizeDecisionSyncTarget(syncTarget);
      if (normalizedSyncTarget === 'icse') {
        return 'ICSE';
      }
      if (normalizedSyncTarget === 'fse') {
        return 'FSE';
      }
      return 'arXiv';
    }

    function updateAuthUi() {
      if (!authState.configured) {
        elements.authStatus.textContent = 'Cloud sync unavailable';
        elements.syncStatus.textContent = authState.error || 'Add Firebase config to enable login and Firestore sync.';
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
        elements.syncStatus.textContent = 'Syncing settings and review outcomes with Firestore…';
      } else {
        elements.syncStatus.textContent = authState.syncMessage || 'Settings and review outcomes will sync with Firebase Firestore.';
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

    function requireSignedInFirestore() {
      if (!authState.user || !authState.firestore) {
        throw new Error('Sign in to sync with Firestore.');
      }
      return authState.firestore.collection('users').doc(authState.user.id);
    }

    function settingsDocRef() {
      return requireSignedInFirestore().collection('sync').doc('settings');
    }

    function decisionsDocRef(syncTarget) {
      return requireSignedInFirestore()
        .collection('decisions')
        .doc(normalizeDecisionSyncTarget(syncTarget));
    }

    async function readRemoteSettings() {
      const snapshot = await settingsDocRef().get();
      return snapshot.exists ? normalizeSettings(snapshot.data() || {}) : null;
    }

    async function writeRemoteSettings() {
      const settings = normalizeSettings(getSettings());
      await settingsDocRef().set(settings, { merge: true });
    }

    async function readRemoteDecisions({ syncTarget } = {}) {
      const snapshot = await decisionsDocRef(syncTarget).get();
      const payload = snapshot.exists ? snapshot.data() : null;
      return normalizeDecisionMap(payload?.decisions || {});
    }

    async function writeRemoteDecisions({ syncTarget } = {}) {
      const normalizedSyncTarget = normalizeDecisionSyncTarget(syncTarget);
      await decisionsDocRef(normalizedSyncTarget).set({
        updatedAt: new Date().toISOString(),
        decisions: normalizeDecisionMap(getDecisionsForSyncTarget(normalizedSyncTarget)),
      });
    }

    function handleCloudSyncError(error) {
      console.error(error);
      authState.busy = false;
      authState.syncInProgress = false;
      authState.error = getFirebaseAuthErrorMessage(error);
      updateAuthUi();
    }

    async function syncSettingsFromCloud() {
      if (!authState.user) {
        return false;
      }

      authState.syncInProgress = true;
      authState.syncMessage = 'Checking Firestore settings…';
      updateAuthUi();

      try {
        const remoteSettings = await readRemoteSettings();
        const localSettings = normalizeSettings(getSettings());

        if (remoteSettings && isRemoteSettingsNewer(remoteSettings.updatedAt, localSettings.updatedAt)) {
          setSettings(remoteSettings);
          saveSettings();
          applySettings();
          authState.syncMessage = 'Settings downloaded from Firestore.';
          authState.syncInProgress = false;
          authState.error = '';
          updateAuthUi();
          return true;
        }

        await syncSettingsToCloud();
        return true;
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }
    }

    async function syncSettingsToCloud() {
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
        await writeRemoteSettings();
        authState.error = '';
        authState.syncMessage = 'Settings synced to Firestore.';
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }

      authState.syncInProgress = false;
      updateAuthUi();
      return true;
    }

    async function syncDecisionsFromCloud() {
      if (!authState.user) {
        return false;
      }

      const syncTarget = getDecisionSyncTarget();
      const decisionSheetLabel = getDecisionSheetLabel(syncTarget);
      authState.syncInProgress = true;
      authState.syncMessage = `Checking Firestore for ${decisionSheetLabel} review outcomes…`;
      updateAuthUi();

      try {
        const remoteDecisions = await readRemoteDecisions({ syncTarget });
        const mergedDecisions = mergeDecisionMaps(normalizeDecisionMap(getDecisions()), remoteDecisions);
        setDecisions(mergedDecisions);
        saveDecisions();
        renderIfReady();

        await syncDecisionsToCloud();
        authState.syncMessage = `Settings and ${decisionSheetLabel} review outcomes synced to Firestore.`;
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }

      authState.syncInProgress = false;
      updateAuthUi();
      return true;
    }

    async function syncDecisionsToCloud() {
      if (!authState.user) {
        return false;
      }

      const syncTarget = getDecisionSyncTarget();
      const decisionSheetLabel = getDecisionSheetLabel(syncTarget);
      authState.syncInProgress = true;
      updateAuthUi();

      try {
        await writeRemoteDecisions({ syncTarget });
        authState.error = '';
        authState.syncMessage = `${decisionSheetLabel} review outcomes synced to Firestore.`;
      } catch (error) {
        handleCloudSyncError(error);
        return false;
      }

      authState.syncInProgress = false;
      updateAuthUi();
      return true;
    }

    async function syncFromCloud() {
      const settingsSynced = await syncSettingsFromCloud();
      const decisionsSynced = await syncDecisionsFromCloud();
      return Boolean(settingsSynced && decisionsSynced);
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
        const result = await authState.firebaseAuth.signInWithPopup(authState.googleProvider);
        authState.user = getFirebaseUserProfile(result.user);
        await syncFromCloud();
        closeSettingsMenu();
        flashStatus('Signed in with Firebase sync.');
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
        clearDecisionSyncTimer();
        await authState.firebaseAuth.signOut();
        authState.user = null;
        authState.error = '';
        authState.syncInProgress = false;
        authState.syncMessage = 'Signed out. Your settings and review outcomes remain saved on this device.';
        closeSettingsMenu();
        flashStatus('Signed out from Firebase sync.');
      } catch (error) {
        handleCloudSyncError(error);
        return;
      }

      authState.busy = false;
      updateAuthUi();
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

      const config = getConfig();
      if (!config.firebaseConfig?.apiKey || !config.firebaseConfig?.authDomain || !config.firebaseConfig?.projectId) {
        authState.error = 'Firestore sync is not configured. Add Firebase web app config to google-api-config.js.';
        updateAuthUi();
        return;
      }

      if (!window.firebase?.initializeApp || !window.firebase?.auth || !window.firebase?.firestore) {
        authState.error = 'Firebase Auth or Firestore could not be loaded, so cloud sync is unavailable.';
        updateAuthUi();
        return;
      }

      try {
        authState.firebaseApp = window.firebase.apps?.length
          ? window.firebase.app()
          : window.firebase.initializeApp(config.firebaseConfig);
        authState.firebaseAuth = window.firebase.auth(authState.firebaseApp);
        authState.firestore = window.firebase.firestore(authState.firebaseApp);
        authState.firebaseAuth.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL);

        authState.googleProvider = new window.firebase.auth.GoogleAuthProvider();
        authState.googleProvider.addScope('profile');
        authState.googleProvider.addScope('email');
        authState.googleProvider.setCustomParameters({ prompt: 'select_account' });

        authState.configured = true;
        authState.error = '';
        authState.syncMessage = 'Not signed in. Tap Sign in to sync settings and review outcomes with Firestore.';
        updateAuthUi();

        authState.authReadyPromise = new Promise((resolve) => {
          authState.firebaseAuth.onAuthStateChanged((firebaseUser) => {
            authState.user = getFirebaseUserProfile(firebaseUser);
            authState.error = '';
            updateAuthUi();

            if (firebaseUser) {
              syncFromCloud();
            }

            resolve(firebaseUser);
          });
        });
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
