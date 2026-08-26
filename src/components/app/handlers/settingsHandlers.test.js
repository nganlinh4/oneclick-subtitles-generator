import { createSettingsHandlers } from './settingsHandlers';
import {
  getCredentialStateSnapshot,
  initializeCredentialState,
} from '../../../platform/credentialStateController';
import { cancelNativeVideoDownload } from '../../../platform/nativeUrlDownloadAdapter';

vi.mock('../../../platform/nativeUrlDownloadAdapter', () => ({ cancelNativeVideoDownload: vi.fn() }));
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

it('requests cancellation by durable job id and leaves presentation cleanup to its owner', async () => {
  const jobId = '0198a8d7-dbf7-7ee0-a949-f13427fdd78a';
  cancelNativeVideoDownload.mockResolvedValue(true);
  const context = { ...createContext(), currentDownloadId: jobId };

  await createSettingsHandlers(context).handleCancelDownload();

  expect(cancelNativeVideoDownload).toHaveBeenCalledWith(jobId);
  expect(context.setIsDownloading).not.toHaveBeenCalled();
  expect(context.setDownloadProgress).not.toHaveBeenCalled();
  expect(context.setCurrentDownloadId).not.toHaveBeenCalled();
  expect(context.setStatus).not.toHaveBeenCalled();
});

it('a delayed cancellation for A cannot clear the newer B presentation', async () => {
  const jobA = '0198a8d7-dbf7-7ee0-a949-f13427fdd78a';
  const jobB = '0198a8d7-dbf7-7ee0-a949-f13427fdd78b';
  let resolveCancellation;
  cancelNativeVideoDownload.mockReturnValue(new Promise((resolve) => {
    resolveCancellation = resolve;
  }));
  const presentation = {
    currentDownloadId: jobA,
    downloadProgress: 31,
    isDownloading: true,
    status: { message: 'Downloading A', type: 'loading' },
  };
  const context = {
    ...createContext(),
    currentDownloadId: jobA,
    setCurrentDownloadId: vi.fn((value) => { presentation.currentDownloadId = value; }),
    setDownloadProgress: vi.fn((value) => { presentation.downloadProgress = value; }),
    setIsDownloading: vi.fn((value) => { presentation.isDownloading = value; }),
    setStatus: vi.fn((value) => { presentation.status = value; }),
  };

  const cancellingA = createSettingsHandlers(context).handleCancelDownload();
  await vi.waitFor(() => expect(cancelNativeVideoDownload).toHaveBeenCalledWith(jobA));

  // A new render owner publishes B while Rust is still processing A's cancellation.
  presentation.currentDownloadId = jobB;
  presentation.downloadProgress = 12;
  presentation.isDownloading = true;
  presentation.status = { message: 'Downloading B', type: 'loading' };
  resolveCancellation(true);
  await cancellingA;

  expect(presentation).toEqual({
    currentDownloadId: jobB,
    downloadProgress: 12,
    isDownloading: true,
    status: { message: 'Downloading B', type: 'loading' },
  });
  expect(context.setCurrentDownloadId).not.toHaveBeenCalled();
  expect(context.setDownloadProgress).not.toHaveBeenCalled();
  expect(context.setIsDownloading).not.toHaveBeenCalled();
  expect(context.setStatus).not.toHaveBeenCalled();
});

it('does not claim native cancellation succeeded when the command fails', async () => {
  cancelNativeVideoDownload.mockRejectedValue(new Error('transport detail'));
  const context = { ...createContext(), currentDownloadId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a' };

  await createSettingsHandlers(context).handleCancelDownload();

  expect(context.setCurrentDownloadId).not.toHaveBeenCalled();
  expect(context.setStatus).not.toHaveBeenCalled();
});

it('does not make retry available when the adapter cannot detach that native operation', async () => {
  cancelNativeVideoDownload.mockResolvedValue(false);
  const context = { ...createContext(), currentDownloadId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a' };

  await createSettingsHandlers(context).handleCancelDownload();

  expect(context.setCurrentDownloadId).not.toHaveBeenCalled();
  expect(context.setIsDownloading).not.toHaveBeenCalled();
  expect(context.setStatus).not.toHaveBeenCalled();
});

it('changes acquisition tabs without discarding the active media project', () => {
  const context = createContext();
  localStorage.setItem('current_video_url', 'https://example.test/current');
  localStorage.setItem('current_file_url', 'http://127.0.0.1:49152/asset/current');
  localStorage.setItem('current_file_cache_id', 'legacy-browser-id');

  createSettingsHandlers(context).handleTabChange('file-upload');

  expect(context.setActiveTab).toHaveBeenCalledExactlyOnceWith('file-upload');
  expect(localStorage.getItem('userPreferredTab')).toBe('file-upload');
  expect(localStorage.getItem('lastActiveTab')).toBe('file-upload');
  expect(localStorage.getItem('current_video_url')).toBe('https://example.test/current');
  expect(localStorage.getItem('current_file_url')).toBe('http://127.0.0.1:49152/asset/current');
  expect(localStorage.getItem('current_file_cache_id')).toBe('legacy-browser-id');
  expect(context.setStatus).toHaveBeenCalledExactlyOnceWith({});
  expect(context.setSelectedVideo).not.toHaveBeenCalled();
  expect(context.setUploadedFile).not.toHaveBeenCalled();
  expect(context.setSubtitlesData).not.toHaveBeenCalled();
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

it('keeps the selected cookie browser when the legacy-shaped callback updates the toggle', async () => {
  localStorage.setItem('download_cookie_source', 'firefox');
  const context = createContext();

  await createSettingsHandlers(context).saveApiKeys(
    '', '', '', 5, 'gemini-2.5-flash', 'hms', undefined, '360p', false, true
  );

  expect(localStorage.getItem('use_cookies_for_download')).toBe('true');
  expect(localStorage.getItem('download_cookie_source')).toBe('firefox');
  expect(context.setUseCookiesForDownload).toHaveBeenCalledWith(true);
});
