import { createSettingsHandlers } from './settingsHandlers';
import {
  getCredentialStateSnapshot,
  initializeCredentialState,
} from '../../../platform/credentialStateController';
import { cancelNativeVideoDownload } from '../../../platform/nativeUrlDownloadAdapter';
import { readActiveMedia, updateActiveMedia } from '../../../platform/activeMediaSource';

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
  updateActiveMedia({
    sourceUrl: 'https://example.test/current',
    playbackUrl: 'http://127.0.0.1:49152/asset/current',
  });

  createSettingsHandlers(context).handleTabChange('file-upload');

  expect(context.setActiveTab).toHaveBeenCalledExactlyOnceWith('file-upload');
  expect(localStorage.getItem('userPreferredTab')).toBe('file-upload');
  expect(localStorage.getItem('lastActiveTab')).toBe('file-upload');
  expect(readActiveMedia()).toMatchObject({
    sourceUrl: 'https://example.test/current',
    playbackUrl: 'http://127.0.0.1:49152/asset/current',
  });
  expect(context.setStatus).toHaveBeenCalledExactlyOnceWith({});
  expect(context.setSelectedVideo).not.toHaveBeenCalled();
  expect(context.setUploadedFile).not.toHaveBeenCalled();
  expect(context.setSubtitlesData).not.toHaveBeenCalled();
});

it('refreshes credential availability from native status after a save', async () => {
  const context = createContext();

  await createSettingsHandlers(context).saveApiKeys();

  expect(context.setApiKeysSet).toHaveBeenCalledWith({
    gemini: true,
    youtube: true,
    genius: false,
  });
  expect(context.setStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

it('fails closed for native OAuth because client metadata is not an access token', async () => {
  localStorage.setItem('use_youtube_oauth', 'true');
  const context = createContext();

  await createSettingsHandlers(context).saveApiKeys();

  expect(context.setApiKeysSet).toHaveBeenCalledWith(expect.objectContaining({
    youtube: false,
  }));
});
