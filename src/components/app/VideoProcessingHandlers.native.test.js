import { runMediaPipeline } from '../../platform/mediaPipelineService';
import { createNativeMediaDescriptor } from '../../platform/mediaService';
import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';
import { setCurrentCacheId as setRulesCacheId } from '../../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../../utils/userSubtitlesStore';
import {
  downloadAndPrepareYouTubeVideo,
  ensureVideoCompatibility,
} from './VideoProcessingHandlers';
import {
  AutoGenerationOwnershipError,
  createAutoGenerationRequest,
} from '../../utils/autoGenerationOwnership';

vi.mock('../../platform/desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: () => true,
}));
vi.mock('../../platform/mediaPipelineService', () => ({ runMediaPipeline: vi.fn() }));
vi.mock('../../platform/nativeUrlDownloadAdapter', () => ({ downloadNativeVideo: vi.fn() }));
vi.mock('../../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(async (cacheId) => ({ projectId: `project:${cacheId}` })),
}));
vi.mock('../../services/subtitleCache', () => ({ generateUrlBasedCacheId: vi.fn() }));
vi.mock('../../utils/transcriptionRulesStore', () => ({ setCurrentCacheId: vi.fn() }));
vi.mock('../../utils/userSubtitlesStore', () => ({ setCurrentCacheId: vi.fn() }));

const SOURCE_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const source = createNativeMediaDescriptor({
  asset: {
    id: SOURCE_ID,
    displayName: 'source.mkv',
    extension: 'mkv',
    sizeBytes: 4096,
    kind: 'video',
  },
  playback: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`,
    mimeType: 'video/x-matroska',
    byteLength: 4096,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

it('prepares native playback by asset ID and returns a validated descriptor', async () => {
  runMediaPipeline.mockResolvedValue({
    kind: 'media',
    media: {
      asset: {
        id: '01890f39-7b62-7c4e-8c9a-000000000102',
        displayName: 'source.mp4',
        extension: 'mp4',
        sizeBytes: 8192,
        kind: 'video',
      },
      playback: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        playbackUrl: `http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=${'b'.repeat(64)}`,
        mimeType: 'video/mp4',
        byteLength: 8192,
      },
    },
  });
  const fetchSpy = vi.spyOn(global, 'fetch');

  const prepared = await ensureVideoCompatibility(source);

  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'preparePlayback',
    assetId: SOURCE_ID,
  });
  expect(prepared).toMatchObject({
    __nativeMedia: true,
    name: 'source.mp4',
    type: 'video/mp4',
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('shows a localized actionable error only after the downloader retry is exhausted', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'edge');
  downloadNativeVideo.mockRejectedValueOnce(Object.assign(new Error('private native failure'), {
    code: 'downloaderExecutionFailed',
  }));
  const setStatus = vi.fn();
  const t = (key, fallback) => ({
    'errors.videoDownloadFailed': 'Tải video thất bại',
    'errors.videoDownloadExecutionFailed': 'Đã thử lại; hãy kiểm tra mạng hoặc cookie.',
  })[key] ?? fallback;

  await expect(downloadAndPrepareYouTubeVideo(
    { url: 'https://www.youtube.com/watch?v=reviewed' },
    vi.fn(),
    vi.fn(),
    setStatus,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    (_key, fallback) => fallback,
    t,
  )).resolves.toBeUndefined();

  expect(setStatus).toHaveBeenLastCalledWith({
    message: 'Tải video thất bại: Đã thử lại; hãy kiểm tra mạng hoặc cookie.',
    type: 'error',
  });
  expect(JSON.stringify(setStatus.mock.calls)).not.toContain('private native failure');
  expect(downloadNativeVideo).toHaveBeenCalledWith(expect.objectContaining({
    cookieSource: 'edge',
  }));
});

it('activates the URL project before publishing downloaded media to React', async () => {
  downloadNativeVideo.mockResolvedValue(source);
  generateUrlBasedCacheId.mockResolvedValue('reviewed');
  const setUploadedFile = vi.fn();

  await expect(downloadAndPrepareYouTubeVideo(
    { url: 'https://www.youtube.com/watch?v=reviewed' },
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    setUploadedFile,
    vi.fn(),
  )).resolves.toBe(source);

  expect(setRulesCacheId).toHaveBeenCalledWith('reviewed');
  expect(setSubtitlesCacheId).toHaveBeenCalledWith('reviewed');
  expect(setRulesCacheId.mock.invocationCallOrder[0])
    .toBeLessThan(setUploadedFile.mock.invocationCallOrder[0]);
  expect(setSubtitlesCacheId.mock.invocationCallOrder[0])
    .toBeLessThan(setUploadedFile.mock.invocationCallOrder[0]);
});

it('a stale automatic download cannot clear or overwrite a newer download presentation', async () => {
  let rejectA;
  let resolveB;
  downloadNativeVideo
    .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectA = reject; }))
    .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
  generateUrlBasedCacheId.mockResolvedValue('project-b');
  const setIsDownloading = vi.fn();
  const setDownloadProgress = vi.fn();
  const setStatus = vi.fn();
  const setCurrentDownloadId = vi.fn();
  const common = [
    setIsDownloading,
    setDownloadProgress,
    setStatus,
    setCurrentDownloadId,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  ];
  const controllerA = new AbortController();
  const requestA = createAutoGenerationRequest({ runId: 'run-a', signal: controllerA.signal });
  localStorage.setItem('current_video_url', 'https://example.test/a');
  const a = downloadAndPrepareYouTubeVideo(
    { url: 'https://example.test/a' },
    ...common,
    { autoRequest: requestA }
  );
  await vi.waitFor(() => expect(downloadNativeVideo).toHaveBeenCalledTimes(1));

  const controllerB = new AbortController();
  const requestB = createAutoGenerationRequest({ runId: 'run-b', signal: controllerB.signal });
  localStorage.setItem('current_video_url', 'https://example.test/b');
  const b = downloadAndPrepareYouTubeVideo(
    { url: 'https://example.test/b' },
    ...common,
    { autoRequest: requestB }
  );
  await vi.waitFor(() => expect(downloadNativeVideo).toHaveBeenCalledTimes(2));
  const callsOwnedByB = {
    downloading: setIsDownloading.mock.calls.length,
    progress: setDownloadProgress.mock.calls.length,
    status: setStatus.mock.calls.length,
    job: setCurrentDownloadId.mock.calls.length,
  };

  rejectA(new AutoGenerationOwnershipError());
  await expect(a).rejects.toMatchObject({ code: 'autoGenerationOwnershipLost' });
  expect(setIsDownloading).toHaveBeenCalledTimes(callsOwnedByB.downloading);
  expect(setDownloadProgress).toHaveBeenCalledTimes(callsOwnedByB.progress);
  expect(setStatus).toHaveBeenCalledTimes(callsOwnedByB.status);
  expect(setCurrentDownloadId).toHaveBeenCalledTimes(callsOwnedByB.job);

  resolveB(source);
  await expect(b).resolves.toBe(source);
  expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'loading' }));
  expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  expect(setIsDownloading).toHaveBeenLastCalledWith(false);
});
