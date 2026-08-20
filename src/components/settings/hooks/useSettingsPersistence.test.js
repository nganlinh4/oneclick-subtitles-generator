import useSettingsPersistence from './useSettingsPersistence';
import { upsertSingletonCredential } from '../../../platform/credentialStateController';
import { invokeDesktop } from '../../../platform/desktopRuntime';

vi.mock('../../../platform/credentialStateController', () => ({
  upsertSingletonCredential: vi.fn(),
}));
vi.mock('../../../utils/geminiEffects', () => ({
  initGeminiButtonEffects: vi.fn(),
  disableGeminiButtonEffects: vi.fn(),
}));
vi.mock('../../../platform/desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const createParams = (overrides = {}) => ({
  geminiApiKey: 'stale-gemini-secret',
  youtubeApiKey: 'fresh-youtube-secret',
  geniusApiKey: 'fresh-genius-secret',
  segmentDuration: 5,
  geminiModel: 'gemini-2.5-flash',
  timeFormat: 'hms',
  showWaveformLongVideos: false,
  segmentOffsetCorrection: -3,
  transcriptionPrompt: 'prompt',
  useOAuth: false,
  youtubeClientId: 'oauth-client-id',
  youtubeClientSecret: 'oauth-client-secret',
  useVideoAnalysis: true,
  videoAnalysisModel: 'gemini-2.5-flash',
  videoAnalysisTimeout: '10',
  enableGeminiEffects: false,
  optimizeVideos: false,
  optimizedResolution: '360p',
  useOptimizedPreview: false,
  useCookiesForDownload: false,
  downloadCookieSource: 'chrome',
  enableYoutubeSearch: false,
  autoImportSiteSubtitles: true,
  favoriteMaxSubtitleLength: 12,
  showFavoriteMaxLength: true,
  thinkingBudgets: {},
  customGeminiModels: [],
  setOriginalSettings: vi.fn(),
  setHasChanges: vi.fn(),
  setIsSettingsLoaded: vi.fn(),
  setGeminiApiKey: vi.fn(),
  setYoutubeApiKey: vi.fn(),
  setGeniusApiKey: vi.fn(),
  setYoutubeClientId: vi.fn(),
  setYoutubeClientSecret: vi.fn(),
  onSave: vi.fn(),
  handleClose: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  upsertSingletonCredential.mockResolvedValue('01901234-5678-7abc-8def-0123456789ab');
  invokeDesktop.mockResolvedValue(undefined);
});

it('submits native drafts once, clears form fields, and never stores or forwards secrets', async () => {
  localStorage.setItem('backend_available', 'true');
  localStorage.setItem('gemini_api_key', 'legacy-secret');
  const params = createParams();

  await useSettingsPersistence(params).handleSave();

  expect(upsertSingletonCredential.mock.calls).toEqual([
    ['geniusAccessToken', 'fresh-genius-secret'],
    ['youtubeApiKey', 'fresh-youtube-secret'],
    ['youtubeOauthClient', JSON.stringify({
      clientId: 'oauth-client-id',
      clientSecret: 'oauth-client-secret',
    })],
  ]);
  expect(params.setGeminiApiKey).toHaveBeenCalledWith('');
  expect(params.setYoutubeApiKey).toHaveBeenCalledWith('');
  expect(params.setGeniusApiKey).toHaveBeenCalledWith('');
  expect(params.setYoutubeClientId).toHaveBeenCalledWith('');
  expect(params.setYoutubeClientSecret).toHaveBeenCalledWith('');
  expect(localStorage.getItem('gemini_api_key')).toBeNull();
  expect(localStorage.getItem('youtube_api_key')).toBeNull();
  expect(localStorage.getItem('genius_token')).toBeNull();
  expect(params.onSave.mock.calls[0].slice(0, 3)).toEqual(['', '', '']);
  expect(invokeDesktop).toHaveBeenCalledWith('settings_set_many', {
    values: expect.objectContaining({
      segment_duration: '5',
      use_cookies_for_download: 'false',
      download_cookie_source: 'chrome',
    }),
  });
  const nativeValues = invokeDesktop.mock.calls[0][1].values;
  expect(Object.keys(nativeValues)).not.toEqual(expect.arrayContaining([
    'gemini_api_key',
    'youtube_api_key',
    'youtube_client_secret',
  ]));
  expect(params.setOriginalSettings.mock.calls[0][0]).toEqual(expect.objectContaining({
    geminiApiKey: '',
    youtubeApiKey: '',
    geniusApiKey: '',
    youtubeClientId: '',
    youtubeClientSecret: '',
  }));
});

it('clears native form drafts even when secure submission fails', async () => {
  upsertSingletonCredential.mockRejectedValueOnce(new Error('safe failure'));
  const params = createParams();

  await expect(useSettingsPersistence(params).handleSave()).rejects.toThrow('safe failure');

  expect(params.setGeminiApiKey).toHaveBeenCalledWith('');
  expect(params.setYoutubeApiKey).toHaveBeenCalledWith('');
  expect(params.setGeniusApiKey).toHaveBeenCalledWith('');
  expect(params.setYoutubeClientId).toHaveBeenCalledWith('');
  expect(params.setYoutubeClientSecret).toHaveBeenCalledWith('');
  expect(params.onSave).not.toHaveBeenCalled();
  expect(params.handleClose).not.toHaveBeenCalled();
});

it('never revives raw-key persistence when legacy server flags are present', async () => {
  localStorage.setItem('backend_available', 'true');
  localStorage.setItem('gemini_api_keys', '["legacy-secret"]');
  const params = createParams({ youtubeClientId: '', youtubeClientSecret: '' });

  await useSettingsPersistence(params).handleSave();

  expect(localStorage.getItem('gemini_api_keys')).toBeNull();
  expect(localStorage.getItem('youtube_api_key')).toBeNull();
  expect(localStorage.getItem('genius_token')).toBeNull();
  expect(params.onSave.mock.calls[0].slice(0, 3)).toEqual(['', '', '']);
});

it('persists the cookie toggle and selected browser as one preference', async () => {
  const params = createParams({
    useCookiesForDownload: true,
    downloadCookieSource: 'firefox',
    youtubeClientId: '',
    youtubeClientSecret: '',
  });

  await useSettingsPersistence(params).handleSave();

  expect(localStorage.getItem('use_cookies_for_download')).toBe('true');
  expect(localStorage.getItem('download_cookie_source')).toBe('firefox');
  expect(params.setOriginalSettings).toHaveBeenCalledWith(expect.objectContaining({
    useCookiesForDownload: true,
    downloadCookieSource: 'firefox',
  }));
});

it('durably writes the complete preference snapshot before success and close', async () => {
  const order = [];
  invokeDesktop.mockImplementationOnce(async () => { order.push('sqlite'); });
  const params = createParams({
    youtubeClientId: '',
    youtubeClientSecret: '',
    useCookiesForDownload: true,
    downloadCookieSource: 'edge',
    onSave: vi.fn(async () => { order.push('success'); }),
    handleClose: vi.fn(() => { order.push('close'); }),
  });

  await useSettingsPersistence(params).handleSave();

  expect(order).toEqual(['sqlite', 'success', 'close']);
  expect(invokeDesktop.mock.calls[0][1].values).toEqual(expect.objectContaining({
    segment_duration: '5',
    transcription_prompt: 'prompt',
    use_video_analysis: 'true',
    optimized_resolution: '360p',
    use_cookies_for_download: 'true',
    download_cookie_source: 'edge',
    auto_import_site_subtitles: 'true',
    custom_gemini_models: '[]',
  }));
});

it('does not publish browser state, success, or close when SQLite persistence fails', async () => {
  localStorage.setItem('time_format', 'seconds');
  localStorage.setItem('download_cookie_source', 'firefox');
  invokeDesktop.mockRejectedValueOnce(new Error('native settings unavailable'));
  const params = createParams({
    timeFormat: 'hms',
    useCookiesForDownload: true,
    downloadCookieSource: 'edge',
    youtubeClientId: '',
    youtubeClientSecret: '',
  });

  await expect(useSettingsPersistence(params).handleSave())
    .rejects.toThrow('native settings unavailable');

  expect(localStorage.getItem('time_format')).toBe('seconds');
  expect(localStorage.getItem('download_cookie_source')).toBe('firefox');
  expect(localStorage.getItem('use_cookies_for_download')).toBeNull();
  expect(params.onSave).not.toHaveBeenCalled();
  expect(params.setOriginalSettings).not.toHaveBeenCalled();
  expect(params.setHasChanges).not.toHaveBeenCalled();
  expect(params.handleClose).not.toHaveBeenCalled();
});
