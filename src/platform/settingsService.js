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
const transientSettingKeys = new Set(TRANSIENT_SETTING_KEYS);
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
const transientKeyPattern = /^(?:current_|gemini_file_|oauth_)|(?:_cache|_result|_timestamp|_in_progress)$/i;
const nativeSettingKeyPattern = /^[A-Za-z0-9._:-]{1,128}$/;

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

export const isTransientSettingKey = (key) => (
  typeof key === 'string'
  && (transientSettingKeys.has(key) || transientKeyPattern.test(key))
);

export const collectPersistableSettings = (storage) => {
  const settings = {};

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!isNativeSettingKey(key)
        || isCredentialSettingKey(key)
        || isProjectScopedSettingKey(key)
        || isTransientSettingKey(key)) {
      continue;
    }

    try {
      settings[key] = storage.getItem(key);
    } catch (error) {
      console.error(`Error reading localStorage key ${key}:`, error);
    }
  }

  return settings;
};

export const persistDesktopSettings = async (storage) => {
  const values = collectPersistableSettings(storage);
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
