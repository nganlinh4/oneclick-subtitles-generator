import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
  deleteCredential,
  getCredentialStatus,
  setCredential,
  upsertCredential,
} from './credentialService';
import { invokeDesktop } from './desktopRuntime';

export const GEMINI_SELECTION_SETTING_KEY = 'gemini.keySelection.v1';
export const GEMINI_CREDENTIAL_COOLDOWN_MS = 5 * 60 * 1000;

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_LEGACY_GEMINI_KEYS = 32;
const GEMINI_PURPOSE = 'geminiApiKey';
const LEGACY_SECRET_KEYS = Object.freeze([
  'gemini_api_key',
  'gemini_api_keys',
  'gemini_token',
  'gemini_blacklisted_keys',
  'genius_token',
  'youtube_api_key',
  'youtube_client_id',
  'youtube_client_secret',
  'youtube_oauth_token',
]);
const LEGACY_SELECTION_KEYS = Object.freeze(['gemini_active_key_index']);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const defaultSnapshot = () => Object.freeze({
  initialized: false,
  store: 'unavailable',
  credentials: Object.freeze([]),
  gemini: Object.freeze({
    activeCredentialId: null,
    activeIndex: -1,
    availableCredentialIds: Object.freeze([]),
    cooldowns: Object.freeze([]),
  }),
  legacyMigrationFailed: false,
});

export class CredentialStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialStateError';
    this.code = code;
  }
}

const invalidSelection = () => new CredentialStateError(
  'invalidCredentialSelection',
  'The credential selection is invalid'
);

const credentialAlreadyConfigured = () => new CredentialStateError(
  'credentialAlreadyConfigured',
  'A credential is already configured for this purpose'
);

const safeRead = (storage, key) => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const safeRemove = (storage, key) => {
  try {
    storage?.removeItem(key);
  } catch {
    // Failing closed in-memory still prevents any native provider caller from receiving the key.
  }
};

const readLegacyDraftsAndPurge = (storage) => {
  if (!storage) return [];

  const geminiSecrets = [];
  const seenGeminiSecrets = new Set();
  const addGeminiSecret = (value) => {
    if (typeof value !== 'string'
        || value.length === 0
        || seenGeminiSecrets.has(value)
        || geminiSecrets.length >= MAX_LEGACY_GEMINI_KEYS) return;
    seenGeminiSecrets.add(value);
    geminiSecrets.push(value);
  };

  const multiKeyValue = safeRead(storage, 'gemini_api_keys');
  if (multiKeyValue !== null) {
    try {
      const parsed = JSON.parse(multiKeyValue);
      if (Array.isArray(parsed)) parsed.forEach(addGeminiSecret);
    } catch {
      // A corrupt legacy value is purged below and never copied into native state.
    }
  }
  addGeminiSecret(safeRead(storage, 'gemini_api_key'));
  addGeminiSecret(safeRead(storage, 'gemini_token'));

  const drafts = geminiSecrets.map((secret) => ({ purpose: GEMINI_PURPOSE, secret }));
  const geniusSecret = safeRead(storage, 'genius_token');
  if (geniusSecret) drafts.push({ purpose: 'geniusAccessToken', secret: geniusSecret });
  const youtubeSecret = safeRead(storage, 'youtube_api_key');
  if (youtubeSecret) drafts.push({ purpose: 'youtubeApiKey', secret: youtubeSecret });
  const clientId = safeRead(storage, 'youtube_client_id');
  const clientSecret = safeRead(storage, 'youtube_client_secret');
  if (clientId && clientSecret) {
    drafts.push({
      purpose: 'youtubeOauthClient',
      secret: JSON.stringify({ clientId, clientSecret }),
    });
  }

  // Purge synchronously before the first async keyring call. Draft values now exist only in this
  // submit operation and cannot be observed by legacy WebView callers during migration.
  LEGACY_SECRET_KEYS.forEach((key) => safeRemove(storage, key));
  LEGACY_SELECTION_KEYS.forEach((key) => safeRemove(storage, key));
  return drafts;
};

const normalizeSelection = (value, now) => {
  if (!isRecord(value)) return { activeId: null, cooldowns: new Map() };
  const activeId = value.activeId === null || value.activeId === undefined
    ? null
    : isUuidV7(value.activeId) ? value.activeId : null;
  const cooldowns = new Map();
  if (Array.isArray(value.cooldowns) && value.cooldowns.length <= 128) {
    value.cooldowns.forEach((entry) => {
      if (!isRecord(entry)
          || !isUuidV7(entry.id)
          || !Number.isSafeInteger(entry.untilMs)
          || entry.untilMs <= now
          || entry.untilMs > now + MAX_COOLDOWN_MS) return;
      cooldowns.set(entry.id, entry.untilMs);
    });
  }
  return { activeId, cooldowns };
};

const selectionValue = (selection) => ({
  activeId: selection.activeId,
  cooldowns: [...selection.cooldowns]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, untilMs]) => ({ id, untilMs })),
});

const sameSelection = (left, right) => (
  JSON.stringify(selectionValue(left)) === JSON.stringify(selectionValue(right))
);

const copyCredential = (credential) => Object.freeze({
  id: credential.id,
  purpose: credential.purpose,
  provider: credential.provider,
  state: credential.state,
  last4: credential.last4,
});

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
    getCredentialStatus,
  },
  invokeCommand = invokeDesktop,
  storage = typeof window === 'undefined' ? null : window.localStorage,
  now = () => Date.now(),
} = {}) => {
  let snapshot = defaultSnapshot();
  let selection = { activeId: null, cooldowns: new Map() };
  let operationTail = Promise.resolve();
  let initialization = null;
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
    await invokeCommand('setting_set', {
      key: GEMINI_SELECTION_SETTING_KEY,
      value: selectionValue(selection),
    });
  };

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
    const storedSelection = await invokeCommand('setting_get', {
      key: GEMINI_SELECTION_SETTING_KEY,
    });
    selection = normalizeSelection(storedSelection, now());
    const beforeReconcile = {
      activeId: selection.activeId,
      cooldowns: new Map(selection.cooldowns),
    };
    publish(report, legacyMigrationFailed);
    if (!sameSelection(beforeReconcile, selection)) await persistSelection();
    return snapshot;
  };

  const initialize = () => {
    if (snapshot.initialized) return Promise.resolve(snapshot);
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
      const report = await credentialApi.getCredentialStatus();
      publish(report);
      if (!sameSelection(beforeReconcile, selection)) await persistSelection();
      return snapshot;
    });
  };

  const addGeminiCredential = async (secret) => {
    await initialize();
    return enqueue(async () => {
      const status = await credentialApi.setCredential({ purpose: GEMINI_PURPOSE, secret });
      const report = await credentialApi.getCredentialStatus();
      if (selection.activeId === null && status.state === 'ready') selection.activeId = status.id;
      await persistSelection();
      publish(report);
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
      const status = await credentialApi.setCredential({ purpose, secret });
      publish(await credentialApi.getCredentialStatus());
      return status.id;
    });
  };

  const upsertSingletonCredential = async (purpose, secret) => {
    if (purpose === GEMINI_PURPOSE) return addGeminiCredential(secret);
    await initialize();
    return enqueue(async () => {
      const status = await credentialApi.upsertCredential({ purpose, secret });
      publish(await credentialApi.getCredentialStatus());
      return status.id;
    });
  };

  const removeGeminiCredential = async (id) => {
    await initialize();
    return enqueue(async () => {
      if (!snapshot.credentials.some((credential) => (
        credential.id === id && credential.purpose === GEMINI_PURPOSE
      ))) throw invalidSelection();
      const deleted = await credentialApi.deleteCredential(id);
      selection.cooldowns.delete(id);
      if (selection.activeId === id) selection.activeId = null;
      const report = await credentialApi.getCredentialStatus();
      publish(report);
      await persistSelection();
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
      await persistSelection();
      const report = {
        store: snapshot.store,
        credentials: snapshot.credentials,
      };
      return publish(report);
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
      await persistSelection();
      publish({ store: snapshot.store, credentials: snapshot.credentials });
      return next?.id ?? null;
    });
  };

  const clearCredentials = async () => {
    await initialize();
    return enqueue(async () => {
      let failed = false;
      for (const { id } of snapshot.credentials) {
        try {
          await credentialApi.deleteCredential(id);
        } catch {
          failed = true;
        }
      }
      selection = { activeId: null, cooldowns: new Map() };
      try {
        await invokeCommand('setting_delete', { key: GEMINI_SELECTION_SETTING_KEY });
      } catch {
        failed = true;
      }
      publish(await credentialApi.getCredentialStatus());
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
    selectGeminiCredential,
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
export const addSingletonCredential = credentialStateController.addSingletonCredential;
export const upsertSingletonCredential = credentialStateController.upsertSingletonCredential;
export const removeGeminiCredential = credentialStateController.removeGeminiCredential;
export const selectGeminiCredential = credentialStateController.selectGeminiCredential;
export const rotateGeminiCredential = credentialStateController.rotateGeminiCredential;
export const clearCredentials = credentialStateController.clearCredentials;
export const getActiveGeminiCredentialId = credentialStateController.getActiveGeminiCredentialId;
export const getCredentialStateSnapshot = credentialStateController.getSnapshot;
export const subscribeCredentialState = credentialStateController.subscribe;
