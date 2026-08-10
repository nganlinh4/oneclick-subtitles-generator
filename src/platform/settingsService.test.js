import { invokeDesktop } from './desktopRuntime';
import {
  collectPersistableSettings,
  clearDesktopSettings,
  isCredentialSettingKey,
  isNativeSettingKey,
  isProjectScopedSettingKey,
  isTransientSettingKey,
  persistDesktopSettings,
} from './settingsService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const createStorage = (entries) => {
  const keys = Object.keys(entries);
  return {
    length: keys.length,
    key: (index) => keys[index] ?? null,
    getItem: (key) => entries[key] ?? null,
  };
};

const SECRET_SETTING_KEY_CASES = Object.freeze([
  'gemini_api_key',
  'gemini_blacklisted_keys',
  'provider_refresh_token',
  'provider_credentials_v2',
  'provider_token',
  'clientSecret',
  'client.secret',
  'client:secret',
  'client..::--secret',
  'accessToken',
  'refreshToken',
  'privateKey',
  'apiKey',
  'APIKey',
  'oauthToken',
  'providerClientId',
  'providerAuthorization',
  'accountPassword',
  'accountPasswd',
  'accountPassphrase',
  'providerCredential',
  'sessionCookie',
  'browserCookies',
  'oauthJwt',
  'serviceAccessKey',
  'providerBearer',
  'accountSessionId',
  'accountSessionKey',
  'providerAuth',
  'providerAccessTokens',
  'providerRefreshTokens',
  'providerOauthTokens',
  'providerAuthTokens',
  'providerSecrets',
  'clientId',
  'accessKey',
  'bearer',
  'sessionId',
  'sessionKey',
  'auth',
  'token',
  'secret',
  'secretKey',
  'secrets',
  'cookie',
  'cookies',
  'jwt',
]);

const SAFE_SETTING_KEY_CASES = Object.freeze([
  'gemini_model',
  'gemini_max_tokens',
  'maxTokens',
  'tokenCount',
  'theme',
  'keyboard_shortcuts',
]);

beforeEach(() => {
  invokeDesktop.mockReset();
});

it('matches the native settings key boundary before sending a batch', () => {
  expect(isNativeSettingKey('subtitle.editor:zoom-v2')).toBe(true);
  expect(isNativeSettingKey('../../secret')).toBe(false);
  expect(isNativeSettingKey('key with spaces')).toBe(false);
  expect(isNativeSettingKey('x'.repeat(129))).toBe(false);
});

it('recognizes current and future credential-shaped setting keys', () => {
  SECRET_SETTING_KEY_CASES.forEach((key) => expect(isCredentialSettingKey(key)).toBe(true));
  SAFE_SETTING_KEY_CASES.forEach((key) => expect(isCredentialSettingKey(key)).toBe(false));
});

it('keeps project-scoped compatibility data out of global settings', () => {
  expect(isProjectScopedSettingKey('user_provided_subtitles')).toBe(true);
  expect(isProjectScopedSettingKey('transcription_rules')).toBe(true);
  expect(isProjectScopedSettingKey('latest_segment_subtitles')).toBe(true);
  expect(isProjectScopedSettingKey('original_subtitles_map')).toBe(true);
  expect(isProjectScopedSettingKey('language')).toBe(false);
});

it('keeps session capabilities, provider caches, and generated results out of settings', () => {
  expect(isTransientSettingKey('current_file_url')).toBe(true);
  expect(isTransientSettingKey('gemini_active_key_index')).toBe(true);
  expect(isTransientSettingKey('gemini_file_clip_123')).toBe(true);
  expect(isTransientSettingKey('offline_segments_cache')).toBe(true);
  expect(isTransientSettingKey('osg.nativeJobIds.v1')).toBe(true);
  expect(isTransientSettingKey('osg.nativeNarrationAlignment.v1')).toBe(true);
  expect(isTransientSettingKey('osg.nativeNarrationJob.v1')).toBe(true);
  expect(isTransientSettingKey('video_analysis_result')).toBe(true);
  expect(isTransientSettingKey('currentRenderId')).toBe(true);
  expect(isTransientSettingKey('gemini_model')).toBe(false);
  expect(isTransientSettingKey('use_optimized_preview')).toBe(false);
});

it('collects settings without copying credentials into native persistence', () => {
  const storage = createStorage({
    theme: 'dark',
    gemini_model: 'gemini-2.5-flash',
    ...Object.fromEntries(
      SECRET_SETTING_KEY_CASES.map((key) => [key, `secret-value-for-${key}`]),
    ),
    gemini_active_key_index: '0',
    youtube_oauth_token: '{"access_token":"secret-token"}',
    provider_client_secret: 'future-secret',
    current_file_url: 'http://127.0.0.1:49152/asset/id?token=private-capability',
    gemini_file_clip_123: '{"uri":"provider-private"}',
    offline_segments_cache: '{"large":"generated"}',
    'osg.nativeJobIds.v1': '["0198a8d7-dbf7-7ee0-a949-f13427fdd78a"]',
    'osg.nativeNarrationAlignment.v1': '{"jobId":"stale-alignment"}',
    'osg.nativeNarrationJob.v1': '{"jobId":"stale-narration","subtitles":["private"]}',
    video_analysis_result: '{"project":"data"}',
    user_provided_subtitles: 'project-specific text',
    original_subtitles_map: '{"1":{"text":"project-specific text"}}',
    transcription_rules: '{"atmosphere":"quiet"}',
    gemini_max_tokens: '8192',
    maxTokens: '4096',
    tokenCount: '1024',
    '../../invalid': 'cannot-poison-the-batch',
  });

  expect(collectPersistableSettings(storage)).toEqual({
    theme: 'dark',
    gemini_model: 'gemini-2.5-flash',
    gemini_max_tokens: '8192',
    maxTokens: '4096',
    tokenCount: '1024',
  });
});

it('writes all non-credential settings through the allowlisted Tauri command', async () => {
  invokeDesktop.mockResolvedValue(undefined);
  const storage = createStorage({
    language: 'ko',
    theme: 'dark',
    gemini_max_tokens: '8192',
    maxTokens: '4096',
    tokenCount: '1024',
    ...Object.fromEntries(
      SECRET_SETTING_KEY_CASES.map((key) => [key, `secret-value-for-${key}`]),
    ),
  });

  await expect(persistDesktopSettings(storage)).resolves.toEqual({
    success: true,
    message: 'localStorage data saved successfully',
  });
  expect(invokeDesktop).toHaveBeenCalledWith('settings_set_many', {
    values: {
      language: 'ko',
      theme: 'dark',
      gemini_max_tokens: '8192',
      maxTokens: '4096',
      tokenCount: '1024',
    },
  });
});

it('clears the native settings scope without accepting an ambiguous result', async () => {
  invokeDesktop.mockResolvedValueOnce(14);
  await expect(clearDesktopSettings()).resolves.toBe(14);
  expect(invokeDesktop).toHaveBeenCalledWith('settings_clear', {});

  invokeDesktop.mockResolvedValueOnce(Number.MAX_SAFE_INTEGER + 1);
  await expect(clearDesktopSettings()).rejects.toThrow('invalid settings reset result');
});
