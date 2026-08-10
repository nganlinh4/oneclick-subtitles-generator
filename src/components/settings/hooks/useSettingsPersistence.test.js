import useSettingsPersistence from './useSettingsPersistence';
import { upsertSingletonCredential } from '../../../platform/credentialStateController';

vi.mock('../../../platform/credentialStateController', () => ({
  upsertSingletonCredential: vi.fn(),
}));
vi.mock('../../../utils/geminiEffects', () => ({
  initGeminiButtonEffects: vi.fn(),
  disableGeminiButtonEffects: vi.fn(),
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
