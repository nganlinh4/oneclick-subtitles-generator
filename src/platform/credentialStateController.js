import {
  deleteCredential,
  getCredentialStatus,
  replaceCredential,
  setCredential,
  upsertCredential,
} from './credentialService';
import { invokeDesktop } from './desktopRuntime';
import {
  CredentialStateError,
  GEMINI_PURPOSE,
  LEGACY_SECRET_KEYS,
  LEGACY_SELECTION_KEYS,
  MAX_COOLDOWN_MS,
  SINGLETON_PURPOSES,
  copyCredential,
  credentialAlreadyConfigured,
  defaultSnapshot,
  invalidSelection,
  isUuidV7,
  normalizeSelection,
  readLegacyDraftsAndPurge,
  sameSelection,
  selectionValue,
} from './credentialStateModel';
import { isRecord } from './plainDataRecord';

export { CredentialStateError };

export const GEMINI_SELECTION_SETTING_KEY = 'gemini.keySelection.v1';
export const GEMINI_CREDENTIAL_COOLDOWN_MS = 5 * 60 * 1000;


export const formatCredentialReference = (credential) => {
  if (!isRecord(credential) || !isUuidV7(credential.id)) throw invalidSelection();
  const suffix = typeof credential.last4 === 'string' && credential.last4.length > 0
    ? credential.last4
    : '----';
  return `gemini:${credential.id}:${credential.state}:••••${suffix}`;
};

export const getCredentialAvailability = (snapshot, { useOAuth = false } = {}) => {
  const readyPurposes = new Set(
    snapshot?.store === 'available'
      ? snapshot.credentials
        .filter(({ state }) => state === 'ready')
        .map(({ purpose }) => purpose)
      : []
  );
  return Object.freeze({
    gemini: readyPurposes.has(GEMINI_PURPOSE),
    youtube: useOAuth
      ? readyPurposes.has('youtubeOauthClient') && readyPurposes.has('youtubeOauthToken')
      : readyPurposes.has('youtubeApiKey'),
    genius: readyPurposes.has('geniusAccessToken'),
  });
};

export const createCredentialStateController = ({
  credentialApi = {
    setCredential,
    upsertCredential,
    deleteCredential,
    replaceCredential,
    getCredentialStatus,
  },
  invokeCommand = invokeDesktop,
  storage = typeof window === 'undefined' ? null : window.localStorage,
  now = () => Date.now(),
} = {}) => {
  let snapshot = defaultSnapshot();
  let selection = { activeId: null, cooldowns: new Map() };
  // Provider work is admitted independently from the key highlighted in Settings. Keeping an
  // opaque last-admitted ID lets concurrent callers round-robin atomically without persisting a
  // preference write for every request or exposing secret material to the WebView.
  let lastAdmittedGeminiId = null;
  let operationTail = Promise.resolve();
  let initialization = null;
  let needsReconcile = false;
  let selectionPersistenceFailed = false;
  const subscribers = new Set();

  const publish = (report, legacyMigrationFailed = snapshot.legacyMigrationFailed) => {
    const currentTime = now();
    const credentials = report.credentials.map(copyCredential);
    const geminiCredentials = credentials.filter(({ purpose }) => purpose === GEMINI_PURPOSE);
    const readyIds = new Set(
      geminiCredentials.filter(({ state }) => state === 'ready').map(({ id }) => id)
    );
    for (const [id, untilMs] of selection.cooldowns) {
      if (!readyIds.has(id) || untilMs <= currentTime) selection.cooldowns.delete(id);
    }
    const availableCredentialIds = geminiCredentials
      .filter(({ id, state }) => state === 'ready' && !selection.cooldowns.has(id))
      .map(({ id }) => id);
    if (!availableCredentialIds.includes(selection.activeId)) {
      selection.activeId = availableCredentialIds[0] ?? null;
    }
    const activeIndex = geminiCredentials.findIndex(({ id }) => id === selection.activeId);

    snapshot = Object.freeze({
      initialized: true,
      store: report.store,
      credentials: Object.freeze(credentials),
      gemini: Object.freeze({
        activeCredentialId: selection.activeId,
        activeIndex,
        availableCredentialIds: Object.freeze(availableCredentialIds),
        cooldowns: Object.freeze([...selection.cooldowns]
          .map(([id, untilMs]) => Object.freeze({ id, untilMs }))),
      }),
      legacyMigrationFailed,
      selectionPersistenceFailed,
    });
    subscribers.forEach((subscriber) => {
      try {
        subscriber(snapshot);
      } catch {
        // Subscriber faults cannot poison credential reconciliation or expose request data.
      }
    });
    return snapshot;
  };

  const enqueue = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => undefined);
    return result;
  };

  const persistSelection = async () => {
    // The vault is authoritative for credentials. A failed preference write must not undo a
    // confirmed credential change or prevent in-session rotation/cooldowns from taking effect.
    try {
      await invokeCommand('setting_set', {
        key: GEMINI_SELECTION_SETTING_KEY,
        value: selectionValue(selection),
      });
      selectionPersistenceFailed = false;
    } catch {
      selectionPersistenceFailed = true;
    }
    publish({ store: snapshot.store, credentials: snapshot.credentials });
  };

  const readCurrentCredentials = async () => {
    try {
      const report = await credentialApi.getCredentialStatus();
      needsReconcile = false;
      return publish(report);
    } catch {
      needsReconcile = true;
      // Never keep stale admission enabled when an ambiguous mutation cannot be reconciled.
      publish({ store: 'unavailable', credentials: snapshot.credentials });
      throw new CredentialStateError('credentialRefreshFailed', 'Credential status could not be refreshed');
    }
  };

  const mutateCredentials = async (operation, applyResult) => {
    let result;
    try {
      result = await operation();
    } catch {
      // A transport failure may arrive after the native write. Reconcile once, never retry a
      // secret-bearing mutation (which could add a duplicate). Preserve only safe error text.
      try { await readCurrentCredentials(); } catch { /* next initialization retries the read */ }
      throw new CredentialStateError('credentialMutationFailed', 'The credential change could not be confirmed');
    }
    applyResult(result);
    return result;
  };

  const publishCredential = (status) => {
    const replaces = (credential) => credential.id === status.id
      || (status.purpose !== GEMINI_PURPOSE && credential.purpose === status.purpose);
    const exists = snapshot.credentials.some(replaces);
    return publish({
      store: 'available',
      credentials: exists
        ? snapshot.credentials.map((credential) => replaces(credential) ? status : credential)
        : [...snapshot.credentials, status],
    });
  };

  const publishRemoval = (id) => publish({
    store: snapshot.store,
    credentials: snapshot.credentials.filter((credential) => credential.id !== id),
  });

  const purgeNativeLegacySettings = async () => {
    let failed = false;
    for (const key of [...LEGACY_SECRET_KEYS, ...LEGACY_SELECTION_KEYS]) {
      try {
        await invokeCommand('setting_delete', { key });
      } catch {
        failed = true;
      }
    }
    return failed;
  };

  const migrateLegacyDrafts = async (report, drafts) => {
    if (drafts.length === 0) return false;
    let failed = false;
    const existingSingletons = new Set(
      report.credentials
        .filter(({ purpose }) => purpose !== GEMINI_PURPOSE)
        .map(({ purpose }) => purpose)
    );
    const hasGeminiCredentials = report.credentials.some(({ purpose }) => purpose === GEMINI_PURPOSE);

    for (const draft of drafts) {
      if ((draft.purpose === GEMINI_PURPOSE && hasGeminiCredentials)
          || (draft.purpose !== GEMINI_PURPOSE && existingSingletons.has(draft.purpose))) {
        continue;
      }
      try {
        await credentialApi.setCredential(draft);
        if (draft.purpose !== GEMINI_PURPOSE) existingSingletons.add(draft.purpose);
      } catch {
        failed = true;
      }
    }
    return failed;
  };

  const initializeDirect = async (legacyDrafts) => {
    const nativeSettingPurgeFailed = await purgeNativeLegacySettings();
    let report = await credentialApi.getCredentialStatus();
    const legacyMigrationFailed = (await migrateLegacyDrafts(report, legacyDrafts))
      || nativeSettingPurgeFailed;
    report = await credentialApi.getCredentialStatus();
    let storedSelection = null;
    try {
      storedSelection = await invokeCommand('setting_get', { key: GEMINI_SELECTION_SETTING_KEY });
    } catch {
      selectionPersistenceFailed = true;
    }
    selection = normalizeSelection(storedSelection, now());
    const beforeReconcile = {
      activeId: selection.activeId,
      cooldowns: new Map(selection.cooldowns),
    };
    publish(report, legacyMigrationFailed);
    if (selectionPersistenceFailed || !sameSelection(beforeReconcile, selection)) await persistSelection();
    return snapshot;
  };

  const initialize = () => {
    if (snapshot.initialized) {
      if (!needsReconcile && snapshot.store === 'available' && !selectionPersistenceFailed) return Promise.resolve(snapshot);
      return enqueue(async () => {
        if (needsReconcile || snapshot.store !== 'available') await readCurrentCredentials();
        if (selectionPersistenceFailed) await persistSelection();
        return snapshot;
      });
    }
    if (initialization === null) {
      // Capture and purge legacy aliases synchronously. No native consumer gets a scheduling window
      // in which it could observe a plaintext WebView credential before the first IPC call.
      const legacyDrafts = readLegacyDraftsAndPurge(storage);
      initialization = enqueue(() => initializeDirect(legacyDrafts));
      initialization.catch(() => { initialization = null; });
    }
    return initialization;
  };

  const refresh = async () => {
    await initialize();
    return enqueue(async () => {
      const beforeReconcile = {
        activeId: selection.activeId,
        cooldowns: new Map(selection.cooldowns),
      };
      await readCurrentCredentials();
      if (selectionPersistenceFailed || !sameSelection(beforeReconcile, selection)) await persistSelection();
      return snapshot;
    });
  };

  const addGeminiCredential = async (secret) => {
    await initialize();
    return enqueue(async () => {
      const status = await mutateCredentials(
        () => credentialApi.setCredential({ purpose: GEMINI_PURPOSE, secret }),
        publishCredential,
      );
      await persistSelection();
      return status.id;
    });
  };

  const addSingletonCredential = async (purpose, secret) => {
    if (purpose === GEMINI_PURPOSE) return addGeminiCredential(secret);
    await initialize();
    return enqueue(async () => {
      if (snapshot.credentials.some((credential) => credential.purpose === purpose)) {
        throw credentialAlreadyConfigured();
      }
      const status = await mutateCredentials(() => credentialApi.setCredential({ purpose, secret }), publishCredential);
      return status.id;
    });
  };

  const upsertSingletonCredential = async (purpose, secret) => {
    if (purpose === GEMINI_PURPOSE) return addGeminiCredential(secret);
    await initialize();
    return enqueue(async () => {
      const status = await mutateCredentials(() => credentialApi.upsertCredential({ purpose, secret }), publishCredential);
      return status.id;
    });
  };

  const removeGeminiCredential = async (id) => {
    await initialize();
    return enqueue(async () => {
      if (!snapshot.credentials.some((credential) => (
        credential.id === id && credential.purpose === GEMINI_PURPOSE
      ))) throw invalidSelection();
      const deleted = await mutateCredentials(() => credentialApi.deleteCredential(id), () => publishRemoval(id));
      await persistSelection();
      return deleted;
    });
  };

  const replaceGeminiCredential = async (id, secret) => {
    await initialize();
    return enqueue(async () => {
      if (!snapshot.credentials.some((credential) => (
        credential.id === id && credential.purpose === GEMINI_PURPOSE
      ))) throw invalidSelection();
      const status = await mutateCredentials(
        () => credentialApi.replaceCredential(id, { purpose: GEMINI_PURPOSE, secret }),
        (updated) => {
          selection.cooldowns.delete(id);
          publishCredential(updated);
        },
      );
      await persistSelection();
      return status.id;
    });
  };

  const removeSingletonCredential = async (purpose) => {
    if (!SINGLETON_PURPOSES.has(purpose)) throw invalidSelection();
    await initialize();
    return enqueue(async () => {
      const matches = snapshot.credentials.filter((credential) => credential.purpose === purpose);
      let deleted = false;
      for (const { id } of matches) {
        deleted = (await mutateCredentials(() => credentialApi.deleteCredential(id), () => publishRemoval(id))) || deleted;
      }
      return deleted;
    });
  };

  const selectGeminiCredential = async (id) => {
    await initialize();
    return enqueue(async () => {
      if (!snapshot.credentials.some((credential) => (
        credential.id === id
          && credential.purpose === GEMINI_PURPOSE
          && credential.state === 'ready'
      ))) throw invalidSelection();
      selection.activeId = id;
      const report = {
        store: snapshot.store,
        credentials: snapshot.credentials,
      };
      publish(report);
      await persistSelection();
      return snapshot;
    });
  };

  const rotateGeminiCredential = async ({
    cooldownCredentialId = null,
    cooldownMs = GEMINI_CREDENTIAL_COOLDOWN_MS,
  } = {}) => {
    await initialize();
    return enqueue(async () => {
      if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > MAX_COOLDOWN_MS) {
        throw invalidSelection();
      }
      const geminiCredentials = snapshot.credentials.filter((credential) => (
        credential.purpose === GEMINI_PURPOSE && credential.state === 'ready'
      ));
      if (cooldownCredentialId !== null) {
        if (!geminiCredentials.some(({ id }) => id === cooldownCredentialId)) {
          throw invalidSelection();
        }
        selection.cooldowns.set(cooldownCredentialId, now() + cooldownMs);
      }

      const activeIndex = geminiCredentials.findIndex(({ id }) => id === selection.activeId);
      const candidates = [...geminiCredentials.slice(activeIndex + 1), ...geminiCredentials.slice(0, activeIndex + 1)];
      const next = candidates.find(({ id }) => !selection.cooldowns.has(id));
      selection.activeId = next?.id ?? selection.activeId;
      publish({ store: snapshot.store, credentials: snapshot.credentials });
      await persistSelection();
      return next?.id ?? null;
    });
  };

  const acquireGeminiCredential = async () => {
    await initialize();
    return enqueue(async () => {
      const ready = snapshot.credentials.filter((credential) => (
        credential.purpose === GEMINI_PURPOSE && credential.state === 'ready'
      ));
      if (snapshot.store !== 'available' || ready.length === 0) return null;
      const readyIds = new Set(ready.map(({ id }) => id));
      const currentTime = now();
      for (const [id, untilMs] of selection.cooldowns) {
        if (!readyIds.has(id) || untilMs <= currentTime) selection.cooldowns.delete(id);
      }
      const previous = ready.findIndex(({ id }) => id === lastAdmittedGeminiId);
      const ordered = previous < 0
        ? ready
        : [...ready.slice(previous + 1), ...ready.slice(0, previous + 1)];
      const next = ordered.find(({ id }) => !selection.cooldowns.has(id));
      if (!next) return null;
      lastAdmittedGeminiId = next.id;
      return next.id;
    });
  };

  const clearCredentials = async () => {
    await initialize();
    return enqueue(async () => {
      let failed = false;
      for (const { id } of snapshot.credentials) {
        try {
          await mutateCredentials(() => credentialApi.deleteCredential(id), () => publishRemoval(id));
        } catch {
          failed = true;
        }
      }
      selection = { activeId: null, cooldowns: new Map() };
      try {
        await invokeCommand('setting_delete', { key: GEMINI_SELECTION_SETTING_KEY });
        selectionPersistenceFailed = false;
      } catch {
        selectionPersistenceFailed = true;
        failed = true;
      }
      await readCurrentCredentials();
      if (failed) {
        throw new CredentialStateError(
          'credentialResetIncomplete',
          'One or more native credentials could not be removed'
        );
      }
      return true;
    });
  };

  const subscribe = (subscriber) => {
    if (typeof subscriber !== 'function') throw invalidSelection();
    subscribers.add(subscriber);
    subscriber(snapshot);
    return () => subscribers.delete(subscriber);
  };

  return Object.freeze({
    initialize,
    refresh,
    addGeminiCredential,
    addSingletonCredential,
    upsertSingletonCredential,
    removeGeminiCredential,
    replaceGeminiCredential,
    removeSingletonCredential,
    selectGeminiCredential,
    acquireGeminiCredential,
    rotateGeminiCredential,
    clearCredentials,
    getActiveGeminiCredentialId: () => {
      if (snapshot.store !== 'available'
          || !snapshot.gemini.availableCredentialIds.includes(
            snapshot.gemini.activeCredentialId
          )) return null;
      return snapshot.gemini.activeCredentialId;
    },
    getSnapshot: () => snapshot,
    subscribe,
  });
};

const credentialStateController = createCredentialStateController();

export const initializeCredentialState = credentialStateController.initialize;
export const refreshCredentialState = credentialStateController.refresh;
export const addGeminiCredential = credentialStateController.addGeminiCredential;
export const upsertSingletonCredential = credentialStateController.upsertSingletonCredential;
export const removeGeminiCredential = credentialStateController.removeGeminiCredential;
export const removeSingletonCredential = credentialStateController.removeSingletonCredential;
export const selectGeminiCredential = credentialStateController.selectGeminiCredential;
export const acquireGeminiCredential = credentialStateController.acquireGeminiCredential;
export const rotateGeminiCredential = credentialStateController.rotateGeminiCredential;
export const clearCredentials = credentialStateController.clearCredentials;
export const getActiveGeminiCredentialId = credentialStateController.getActiveGeminiCredentialId;
export const getCredentialStateSnapshot = credentialStateController.getSnapshot;
export const subscribeCredentialState = credentialStateController.subscribe;
