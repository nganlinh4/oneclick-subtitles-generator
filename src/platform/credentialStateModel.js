// Credential state model: purpose constants, snapshot/selection normalization, the controller's
// error type, and the one-shot purge of legacy WebView-stored secrets. Pure: no IPC.
import { validate as validateUuid, version as uuidVersion } from 'uuid';

export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_LEGACY_GEMINI_KEYS = 32;
export const GEMINI_PURPOSE = 'geminiApiKey';
export const SINGLETON_PURPOSES = new Set([
  'geniusAccessToken',
  'youtubeApiKey',
  'youtubeOauthClient',
  'youtubeOauthToken',
]);
export const LEGACY_SECRET_KEYS = Object.freeze([
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
export const LEGACY_SELECTION_KEYS = Object.freeze(['gemini_active_key_index']);

export const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export const defaultSnapshot = () => Object.freeze({
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
  selectionPersistenceFailed: false,
});

export class CredentialStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CredentialStateError';
    this.code = code;
  }
}

export const invalidSelection = () => new CredentialStateError(
  'invalidCredentialSelection',
  'The credential selection is invalid'
);

export const credentialAlreadyConfigured = () => new CredentialStateError(
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

export const readLegacyDraftsAndPurge = (storage) => {
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

export const normalizeSelection = (value, now) => {
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

export const selectionValue = (selection) => ({
  activeId: selection.activeId,
  cooldowns: [...selection.cooldowns]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, untilMs]) => ({ id, untilMs })),
});

export const sameSelection = (left, right) => (
  JSON.stringify(selectionValue(left)) === JSON.stringify(selectionValue(right))
);

export const copyCredential = (credential) => Object.freeze({
  id: credential.id,
  purpose: credential.purpose,
  provider: credential.provider,
  state: credential.state,
  last4: credential.last4,
});
