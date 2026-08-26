import { invokeDesktop } from './desktopRuntime';
import {
  collectPersistableSettings,
  clearDesktopSettings,
  isCredentialSettingKey,
  isNativeOwnedSettingKey,
  isNativeSettingKey,
  isProjectScopedSettingKey,
  isTransientSettingKey,
  persistDesktopSettings,
  SETTINGS_PERSISTENCE_LIMITS,
  SettingsPersistenceLimitError,
} from './settingsService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

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
  'use_cookies_for_download',
  'download_cookie_source',
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

it('keeps typed native store keys out of legacy preference synchronization', () => {
  expect(isNativeOwnedSettingKey('project.subtitleCacheIndex.v1')).toBe(true);
  expect(isNativeOwnedSettingKey(
    'project.legacyAux.v1.019ffbea-26d5-7800-8e3b-69de8bff2d7d'
  )).toBe(true);
  expect(isNativeOwnedSettingKey('gemini.keySelection.v1')).toBe(true);
  expect(isNativeOwnedSettingKey('project_name')).toBe(false);
});

it('keeps session capabilities, provider caches, and generated results out of settings', () => {
  expect(isTransientSettingKey('current_file_url')).toBe(true);
  expect(isTransientSettingKey('current_settings_bootstrap_v1')).toBe(true);
  expect(isTransientSettingKey('gemini_active_key_index')).toBe(true);
  expect(isTransientSettingKey('gemini_file_clip_123')).toBe(true);
  expect(isTransientSettingKey('offline_segments_cache')).toBe(true);
  expect(isTransientSettingKey('osg.nativeJobIds.v1')).toBe(true);
  expect(isTransientSettingKey('osg.nativeNarrationAlignment.v1')).toBe(true);
  expect(isTransientSettingKey('osg.nativeNarrationJob.v1')).toBe(true);
  expect(isTransientSettingKey('video_analysis_result')).toBe(true);
  expect(isTransientSettingKey('currentRenderId')).toBe(true);
  expect(isTransientSettingKey('CURRENTRENDERID')).toBe(true);
  expect(isTransientSettingKey('Provider-Output-Directory')).toBe(true);
  expect(isTransientSettingKey('Provider-Output-Location')).toBe(true);
  expect(isTransientSettingKey('Provider-Output-Path')).toBe(true);
  expect(isTransientSettingKey('Provider-Output-URI')).toBe(true);
  expect(isTransientSettingKey('Provider-Output-URL')).toBe(true);
  expect(isTransientSettingKey('CURRENT-SESSION')).toBe(true);
  expect(isTransientSettingKey('GEMINI-FILE-UPLOAD')).toBe(true);
  expect(isTransientSettingKey('OAUTH-STATE')).toBe(true);
  expect(isTransientSettingKey('gemini_model')).toBe(false);
  expect(isTransientSettingKey('use_optimized_preview')).toBe(false);
  // Rust only lowercases and replaces '-', so do not invent camel-case or dot normalization.
  expect(isTransientSettingKey('providerOutputPath')).toBe(false);
  expect(isTransientSettingKey('provider.output.path')).toBe(false);
});

it('filters an explicit settings action without copying credentials into native persistence', () => {
  const explicitValues = {
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
    'project.subtitleCacheIndex.v1': '{"activeCacheId":"stale-browser-value"}',
    'project.legacyAux.v1.019ffbea-26d5-7800-8e3b-69de8bff2d7d': '{"stale":true}',
    'gemini.keySelection.v1': '{"credentialId":"stale-browser-value"}',
    gemini_max_tokens: '8192',
    maxTokens: '4096',
    tokenCount: '1024',
    use_cookies_for_download: 'true',
    download_cookie_source: 'firefox',
    '../../invalid': 'cannot-poison-the-batch',
  };

  expect(collectPersistableSettings(explicitValues)).toEqual({
    theme: 'dark',
    gemini_model: 'gemini-2.5-flash',
    gemini_max_tokens: '8192',
    maxTokens: '4096',
    tokenCount: '1024',
    use_cookies_for_download: 'true',
    download_cookie_source: 'firefox',
  });
});

it('cannot sweep unrelated browser-mirror values into an explicit action', () => {
  const ambientBrowserMirror = {
    theme: 'dark',
    download_cookie_source: 'chrome',
    gemini_api_key: 'stored-secret',
  };
  const explicitValues = {
    download_cookie_source: 'firefox',
    time_format: 'hms',
    youtube_client_secret: 'pending-secret',
    current_file_url: 'http://127.0.0.1/private-capability',
    invalid_object: { nested: true },
  };

  expect(collectPersistableSettings(explicitValues)).toEqual({
    download_cookie_source: 'firefox',
    time_format: 'hms',
  });
  expect(collectPersistableSettings(explicitValues)).not.toEqual(
    expect.objectContaining(ambientBrowserMirror),
  );
});

it('writes all non-credential settings through the allowlisted Tauri command', async () => {
  invokeDesktop.mockResolvedValue(undefined);
  const explicitValues = {
    language: 'ko',
    theme: 'dark',
    gemini_max_tokens: '8192',
    maxTokens: '4096',
    tokenCount: '1024',
    use_cookies_for_download: 'true',
    download_cookie_source: 'edge',
    ...Object.fromEntries(
      SECRET_SETTING_KEY_CASES.map((key) => [key, `secret-value-for-${key}`]),
    ),
  };

  await expect(persistDesktopSettings(explicitValues)).resolves.toEqual({
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
      use_cookies_for_download: 'true',
      download_cookie_source: 'edge',
    },
  });
});

it('removes poisoned transient keys from an explicit atomic native batch', async () => {
  const nativeRejectedKeys = new Set([
    'Provider-Output-Directory',
    'Provider-Output-Location',
    'Provider-Output-Path',
    'Provider-Output-URI',
    'Provider-Output-URL',
    'CURRENT-SESSION',
    'GEMINI-FILE-UPLOAD',
    'OAUTH-STATE',
  ]);
  invokeDesktop.mockImplementationOnce(async (_command, { values }) => {
    if (Object.keys(values).some((key) => nativeRejectedKeys.has(key))) {
      throw new Error('native rejected a transient setting');
    }
  });
  const explicitValues = {
    theme: 'dark',
    download_cookie_source: 'firefox',
    'Provider-Output-Directory': 'C:\\private\\output',
    'Provider-Output-Location': 'C:\\private',
    'Provider-Output-Path': 'C:\\private\\video.mp4',
    'Provider-Output-URI': 'file:///C:/private/video.mp4',
    'Provider-Output-URL': 'http://127.0.0.1/private-capability',
    'CURRENT-SESSION': 'private-session-handle',
    'GEMINI-FILE-UPLOAD': 'provider-private-handle',
    'OAUTH-STATE': 'private-oauth-state',
  };

  await expect(persistDesktopSettings(explicitValues)).resolves.toEqual({
    success: true,
    message: 'localStorage data saved successfully',
  });
  expect(invokeDesktop).toHaveBeenCalledWith('settings_set_many', {
    values: {
      theme: 'dark',
      download_cookie_source: 'firefox',
    },
  });
});

it('matches the native per-value JSON-byte boundary', async () => {
  invokeDesktop.mockResolvedValue(undefined);
  const exactValue = 'x'.repeat(SETTINGS_PERSISTENCE_LIMITS.maxValueJsonBytes - 2);
  const oversizedValue = `${exactValue}x`;
  const almostFullUtf8Value = '한'.repeat(
    Math.floor((SETTINGS_PERSISTENCE_LIMITS.maxValueJsonBytes - 2) / 3)
  );
  const oversizedUtf8Value = `${almostFullUtf8Value}한`;

  await expect(persistDesktopSettings({
    exact_value: exactValue,
  })).resolves.toEqual({
    success: true,
    message: 'localStorage data saved successfully',
  });
  expect(invokeDesktop).toHaveBeenCalledWith('settings_set_many', {
    values: { exact_value: exactValue },
  });

  invokeDesktop.mockClear();
  await expect(persistDesktopSettings({
    transcription_prompt: oversizedValue,
  })).rejects.toMatchObject({
    name: 'SettingsPersistenceLimitError',
    code: 'valueTooLarge',
  });
  await expect(persistDesktopSettings({
    transcription_prompt: oversizedUtf8Value,
  })).rejects.toMatchObject({
    name: 'SettingsPersistenceLimitError',
    code: 'valueTooLarge',
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('enforces the native entry boundary for the complete explicit action', async () => {
  invokeDesktop.mockResolvedValue(undefined);
  const exactEntries = Object.fromEntries(
    Array.from(
      { length: SETTINGS_PERSISTENCE_LIMITS.maxEntries },
      (_, index) => [`required_${index}`, 'x']
    )
  );

  await persistDesktopSettings(exactEntries);
  expect(Object.keys(invokeDesktop.mock.calls[0][1].values))
    .toHaveLength(SETTINGS_PERSISTENCE_LIMITS.maxEntries);

  invokeDesktop.mockClear();
  const requiredError = await persistDesktopSettings({
    ...exactEntries,
    required_overflow: 'x',
  })
    .catch((error) => error);
  expect(requiredError).toBeInstanceOf(SettingsPersistenceLimitError);
  expect(requiredError).toMatchObject({ code: 'tooManyEntries' });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('matches the native aggregate-byte boundary without truncating explicit intent', async () => {
  invokeDesktop.mockResolvedValue(undefined);
  const exactAggregateEntries = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => {
      const key = `aggregate${index}`;
      const contentBytes = (1024 * 1024) - key.length - 2;
      return [key, 'x'.repeat(contentBytes)];
    })
  );
  await persistDesktopSettings(exactAggregateEntries);

  const exactValues = invokeDesktop.mock.calls[0][1].values;
  expect(Object.keys(exactValues)).toHaveLength(8);
  expect(exactValues.aggregate0).toBe(exactAggregateEntries.aggregate0);
  expect(exactValues.aggregate7).toBe(exactAggregateEntries.aggregate7);

  invokeDesktop.mockClear();
  await expect(persistDesktopSettings({
    ...exactAggregateEntries,
    required_overflow: 'x',
  })).rejects.toMatchObject({
    name: 'SettingsPersistenceLimitError',
    code: 'batchTooLarge',
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('rejects every malformed UTF-16 shape in pending settings before IPC', async () => {
  const high = String.fromCharCode(0xD800);
  const low = String.fromCharCode(0xDC00);
  const malformedValues = [
    high,
    low,
    `before${high}`,
    `${low}after`,
    `before${high}after`,
    `${high}${high}`,
    `${high}x`,
    `x${low}`,
  ];

  for (const malformedValue of malformedValues) {
    const error = await persistDesktopSettings({
      transcription_prompt: malformedValue,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SettingsPersistenceLimitError);
    expect(error).toMatchObject({ code: 'invalidUnicode' });
  }
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('persists a well-formed mixed Unicode and escaped string at the exact native byte limit', async () => {
  invokeDesktop.mockResolvedValue(undefined);
  const transportPrefix = `😀"\\\0한`;
  const prefixJsonBytes = new TextEncoder().encode(JSON.stringify(transportPrefix)).byteLength;
  expect(prefixJsonBytes).toBe(19);
  const exactTransportValue = transportPrefix
    + 'x'.repeat(SETTINGS_PERSISTENCE_LIMITS.maxValueJsonBytes - prefixJsonBytes);
  expect(new TextEncoder().encode(JSON.stringify(exactTransportValue)).byteLength)
    .toBe(SETTINGS_PERSISTENCE_LIMITS.maxValueJsonBytes);

  await persistDesktopSettings({
    transcription_prompt: exactTransportValue,
  });

  expect(invokeDesktop).toHaveBeenCalledWith('settings_set_many', {
    values: { transcription_prompt: exactTransportValue },
  });
});

it('clears the native settings scope without accepting an ambiguous result', async () => {
  invokeDesktop.mockResolvedValueOnce(14);
  await expect(clearDesktopSettings()).resolves.toBe(14);
  expect(invokeDesktop).toHaveBeenCalledWith('settings_clear', {});

  invokeDesktop.mockResolvedValueOnce(Number.MAX_SAFE_INTEGER + 1);
  await expect(clearDesktopSettings()).rejects.toThrow('invalid settings reset result');
});
