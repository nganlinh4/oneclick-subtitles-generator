import { createSettingsHandlers } from './settingsHandlers';
import {
  getCredentialStateSnapshot,
  initializeCredentialState,
} from '../../../platform/credentialStateController';
import { cancelDownload as cancelNativeDownload } from '../../../platform/downloadService';

vi.mock('../../../platform/downloadService', () => ({ cancelDownload: vi.fn() }));
vi.mock('../../../platform/credentialStateController', async () => {
  const actual = await vi.importActual('../../../platform/credentialStateController');
  return {
    getCredentialAvailability: actual.getCredentialAvailability,
    getCredentialStateSnapshot: vi.fn(),
    initializeCredentialState: vi.fn(),
  };
});

const createContext = () => ({
  activeTab: 'unified-url',
  selectedVideo: null,
  currentDownloadId: null,
  setActiveTab: vi.fn(),
  setSelectedVideo: vi.fn(),
  setUploadedFile: vi.fn(),
  setStatus: vi.fn(),
  setSubtitlesData: vi.fn(),
  setIsDownloading: vi.fn(),
  setDownloadProgress: vi.fn(),
  setCurrentDownloadId: vi.fn(),
  setIsSrtOnlyMode: vi.fn(),
  setTimeFormat: vi.fn(),
  setShowWaveformLongVideos: vi.fn(),
  setOptimizedResolution: vi.fn(),
  setUseOptimizedPreview: vi.fn(),
  setUseCookiesForDownload: vi.fn(),
  setEnableYoutubeSearch: vi.fn(),
  setApiKeysSet: vi.fn(),
  t: (_key, fallback) => fallback,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  initializeCredentialState.mockResolvedValue(undefined);
  getCredentialStateSnapshot.mockReturnValue({
    store: 'available',
    credentials: [
      { purpose: 'geminiApiKey', state: 'ready' },
      { purpose: 'geminiApiKey', state: 'pending' },
      { purpose: 'youtubeApiKey', state: 'ready' },
      { purpose: 'geniusAccessToken', state: 'unavailable' },
    ],
  });
});

it('cancels a native download by durable job id without invoking legacy transports', async () => {
  const jobId = '0198a8d7-dbf7-7ee0-a949-f13427fdd78a';
  cancelNativeDownload.mockResolvedValue({ id: jobId, state: 'cancelling' });
  const context = { ...createContext(), currentDownloadId: jobId };

  await createSettingsHandlers(context).handleCancelDownload();

  expect(cancelNativeDownload).toHaveBeenCalledWith(jobId);
  expect(context.setIsDownloading).toHaveBeenCalledWith(false);
  expect(context.setDownloadProgress).toHaveBeenCalledWith(0);
  expect(context.setCurrentDownloadId).toHaveBeenCalledWith(null);
  expect(context.setStatus).toHaveBeenCalledWith({
    message: 'Download cancelled',
    type: 'warning',
  });
});

it('does not claim native cancellation succeeded when the command fails', async () => {
  cancelNativeDownload.mockRejectedValue(new Error('transport detail'));
  const context = { ...createContext(), currentDownloadId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a' };

  await createSettingsHandlers(context).handleCancelDownload();

  expect(context.setCurrentDownloadId).not.toHaveBeenCalled();
  expect(context.setStatus).not.toHaveBeenCalled();
});

it('ignores and purges secret callback arguments in native mode', async () => {
  localStorage.setItem('gemini_api_key', 'older-secret');
  localStorage.setItem('youtube_oauth_token', 'oauth-secret');
  const context = createContext();

  await createSettingsHandlers(context).saveApiKeys(
    'stale-gemini-secret',
    'stale-youtube-secret',
    'stale-genius-secret',
    5,
    'gemini-2.5-flash',
    'hms'
  );

  expect(localStorage.getItem('gemini_api_key')).toBeNull();
  expect(localStorage.getItem('youtube_api_key')).toBeNull();
  expect(localStorage.getItem('genius_token')).toBeNull();
  expect(localStorage.getItem('youtube_oauth_token')).toBeNull();
  expect(context.setApiKeysSet).toHaveBeenCalledWith({
    gemini: true,
    youtube: true,
    genius: false,
  });
});

it('fails closed for native OAuth because client metadata is not an access token', async () => {
  localStorage.setItem('use_youtube_oauth', 'true');
  const context = createContext();

  await createSettingsHandlers(context).saveApiKeys('', '', '', 5);

  expect(context.setApiKeysSet).toHaveBeenCalledWith(expect.objectContaining({
    youtube: false,
  }));
});

it('never restores raw-key browser persistence when legacy arguments are supplied', async () => {
  localStorage.setItem('gemini_api_keys', '["older-secret"]');
  const context = createContext();

  await createSettingsHandlers(context).saveApiKeys(
    'browser-gemini',
    'browser-youtube',
    'browser-genius',
    5
  );

  expect(localStorage.getItem('gemini_api_key')).toBeNull();
  expect(localStorage.getItem('gemini_api_keys')).toBeNull();
  expect(localStorage.getItem('youtube_api_key')).toBeNull();
  expect(localStorage.getItem('genius_token')).toBeNull();
  expect(context.setApiKeysSet).toHaveBeenCalledWith({
    gemini: true,
    youtube: true,
    genius: false,
  });
});
