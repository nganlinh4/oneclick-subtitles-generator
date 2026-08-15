import { invokeDesktop } from './desktopRuntime';

// Credential values belong exclusively to the native vault. Legacy aliases must never be copied
// into the general-purpose SQLite settings table during browser-storage compatibility sync.
export const CREDENTIAL_SETTING_KEYS = Object.freeze([
  'gemini_api_key',
  'gemini_api_keys',
  'gemini_blacklisted_keys',
  'genius_token',
  'youtube_api_key',
  'youtube_client_id',
  'youtube_client_secret',
  'youtube_oauth_token',
]);

// These values are associated with one media/project alias and are persisted by the project
// compatibility stores. Copying them into the global settings scope would create a stale second
// source of truth after switching projects.
export const PROJECT_SCOPED_SETTING_KEYS = Object.freeze([
  'latest_segment_subtitles',
  'original_subtitles_map',
  'transcription_rules',
  'transcription_rules_video_id',
  'user_provided_subtitles',
]);

// These keys are owned by typed native stores. A same-named legacy localStorage entry contains
// only a JSON string; copying it through the generic preference sync would replace structured
// native data and break project/credential restoration on the next launch.
export const NATIVE_OWNED_SETTING_KEYS = Object.freeze([
  'gemini.keySelection.v1',
  'project.subtitleCacheIndex.v1',
]);

// Runtime handles, capability URLs, generated results, and recomputable caches must not be copied
// into the durable settings table. In particular, `current_file_url` can contain the private media
// server's bearer token and Gemini file-cache rows historically included provider metadata.
export const TRANSIENT_SETTING_KEYS = Object.freeze([
  'currentRenderId',
  'currentRenderItem',
  'gemini_active_key_index',
  'last_optimization_timestamp',
  'offline_segments_cache',
  'osg.nativeJobIds.v1',
  'osg.nativeNarrationAlignment.v1',
  'osg.nativeNarrationJob.v1',
  'originalNarrations',
  'reference_audio_cache',
  'split_result',
  'subtitles_data',
  'toast_history_v1',
  'translatedNarrations',
  'uploaded_srt_info',
  'videoRenderQueue',
  'video_processing_in_progress',
]);

const credentialSettingKeys = new Set(CREDENTIAL_SETTING_KEYS);
const projectScopedSettingKeys = new Set(PROJECT_SCOPED_SETTING_KEYS);
const nativeOwnedSettingKeys = new Set(NATIVE_OWNED_SETTING_KEYS);
// Keep this byte-for-byte equivalent to Rust's `is_transient_setting_key`: native setting keys
// are ASCII, then Rust lowercases them and replaces every '-' with '_' before applying rules.
const normalizeTransientSettingKey = (key) => key.toLowerCase().replace(/-/g, '_');
const transientSettingKeys = new Set(TRANSIENT_SETTING_KEYS.map(normalizeTransientSettingKey));
const credentialKeyFragments = Object.freeze([
  'api_key',
  'apikey',
  'password',
  'passwd',
  'passphrase',
  'credential',
  'client_secret',
  'private_key',
  'authorization',
]);
const exactCredentialKeys = new Set([
  'access_key',
  'access_tokens',
  'auth',
  'auth_tokens',
  'bearer',
  'client_id',
  'cookie',
  'cookies',
  'gemini_blacklisted_keys',
  'jwt',
  'oauth_tokens',
  'refresh_tokens',
  'secret',
  'secret_key',
  'secrets',
  'session_id',
  'session_key',
  'token',
]);
const credentialKeySuffixes = Object.freeze([
  '_access_key',
  '_access_tokens',
  '_auth',
  '_auth_tokens',
  '_bearer',
  '_client_id',
  '_cookie',
  '_cookies',
  '_jwt',
  '_oauth_tokens',
  '_refresh_tokens',
  '_session_id',
  '_session_key',
  '_secret',
  '_secret_key',
  '_secrets',
  '_token',
  '_access_token',
  '_refresh_token',
  '_auth_token',
]);
const transientKeyPrefixes = Object.freeze(['current_', 'gemini_file_', 'oauth_']);
const transientKeySuffixes = Object.freeze([
  '_cache',
  '_result',
  '_timestamp',
  '_in_progress',
  '_directory',
  '_location',
  '_path',
  '_uri',
  '_url',
]);
const nativeSettingKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;
export const SETTINGS_PERSISTENCE_LIMITS = Object.freeze({
  maxEntries: 4_096,
  maxValueJsonBytes: 1024 * 1024,
  maxBatchBytes: 8 * 1024 * 1024,
});
const utf8Encoder = new TextEncoder();

export class SettingsPersistenceLimitError extends Error {
  constructor(code) {
    super('Pending settings exceed the desktop persistence limits');
    this.name = 'SettingsPersistenceLimitError';
    this.code = code;
  }
}

const isWellFormedUtf16 = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      if (index + 1 >= value.length) return false;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xDC00 || nextCodeUnit > 0xDFFF) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
};

const canonicalizeSettingKey = (key) => key
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[._:-]+/g, '_')
  .toLowerCase();

export const isCredentialSettingKey = (key) => {
  if (typeof key !== 'string') {
    return false;
  }

  const canonicalKey = canonicalizeSettingKey(key);
  return credentialSettingKeys.has(canonicalKey)
    || credentialKeyFragments.some((fragment) => canonicalKey.includes(fragment))
    || exactCredentialKeys.has(canonicalKey)
    || credentialKeySuffixes.some((suffix) => canonicalKey.endsWith(suffix));
};

export const isNativeSettingKey = (key) => (
  typeof key === 'string' && nativeSettingKeyPattern.test(key)
);

export const isProjectScopedSettingKey = (key) => (
  typeof key === 'string' && projectScopedSettingKeys.has(key)
);

export const isNativeOwnedSettingKey = (key) => (
  typeof key === 'string'
  && (nativeOwnedSettingKeys.has(key) || key.startsWith('project.legacyAux.v1.'))
);

export const isTransientSettingKey = (key) => {
  if (typeof key !== 'string') {
    return false;
  }

  const normalized = normalizeTransientSettingKey(key);
  return transientSettingKeys.has(normalized)
    || transientKeyPrefixes.some((prefix) => normalized.startsWith(prefix))
    || transientKeySuffixes.some((suffix) => normalized.endsWith(suffix));
};

const isPersistableSettingKey = (key) => (
  isNativeSettingKey(key)
  && !isCredentialSettingKey(key)
  && !isProjectScopedSettingKey(key)
  && !isNativeOwnedSettingKey(key)
  && !isTransientSettingKey(key)
);

export const collectPersistableSettings = (storage, overrides = {}) => {
  const settings = new Map();
  let aggregateBytes = 0;

  const addSetting = (key, value, required) => {
    // JSON.stringify preserves lone UTF-16 surrogates as escape sequences, but Rust strings must
    // be Unicode scalar values. Reject them locally instead of silently repairing transport data.
    if (!isWellFormedUtf16(value)) {
      if (required) throw new SettingsPersistenceLimitError('invalidUnicode');
      return false;
    }

    const valueJsonBytes = utf8Encoder.encode(JSON.stringify(value)).byteLength;
    if (valueJsonBytes > SETTINGS_PERSISTENCE_LIMITS.maxValueJsonBytes) {
      if (required) throw new SettingsPersistenceLimitError('valueTooLarge');
      return false;
    }

    if (settings.size >= SETTINGS_PERSISTENCE_LIMITS.maxEntries) {
      if (required) throw new SettingsPersistenceLimitError('tooManyEntries');
      return false;
    }

    const entryBytes = utf8Encoder.encode(key).byteLength + valueJsonBytes;
    if (aggregateBytes + entryBytes > SETTINGS_PERSISTENCE_LIMITS.maxBatchBytes) {
      if (required) throw new SettingsPersistenceLimitError('batchTooLarge');
      return false;
    }

    settings.set(key, value);
    aggregateBytes += entryBytes;
    return true;
  };

  // Pending form values are the required write. Validate and reserve their native batch budget
  // before considering compatibility rows, so old localStorage cannot crowd out a user edit.
  Object.entries(overrides).forEach(([key, value]) => {
    if (isPersistableSettingKey(key) && typeof value === 'string') {
      addSetting(key, value, true);
    }
  });

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!isPersistableSettingKey(key) || settings.has(key)) {
      continue;
    }

    try {
      const value = storage.getItem(key);
      if (typeof value === 'string') {
        addSetting(key, value, false);
      }
    } catch (error) {
      console.error(`Error reading localStorage key ${key}:`, error);
    }
  }

  return Object.fromEntries(settings);
};

export const persistDesktopSettings = async (storage, overrides = {}) => {
  const values = collectPersistableSettings(storage, overrides);
  await invokeDesktop('settings_set_many', { values });

  // Preserve the legacy service's response contract for callers that inspect the result.
  return {
    success: true,
    message: 'localStorage data saved successfully',
  };
};

export const clearDesktopSettings = async () => {
  const removed = await invokeDesktop('settings_clear', {});
  if (!Number.isSafeInteger(removed) || removed < 0) {
    throw new Error('The desktop host returned an invalid settings reset result');
  }
  return removed;
};
