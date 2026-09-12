import { createNativeMediaDescriptor } from '../../platform/mediaService';
import { invokeDesktop } from '../../platform/desktopRuntime';
import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import {
  ensureProjectOwnsNativeMedia,
  forgetNativeMediaSessionDurably,
} from '../../platform/nativeMediaOwnership';
import {
  activateSubtitleProjectBinding,
  clearSubtitleProjectBinding,
} from '../../platform/subtitleProjectBinding';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';
import { downloadAndPrepareYouTubeVideo } from './VideoProcessingHandlers';
import {
  AutoGenerationOwnershipError,
  createAutoGenerationRequest,
} from '../../utils/autoGenerationOwnership';
import {
  clearBrowserMediaBlobs,
  getBrowserMediaBlob,
  registerBrowserMediaBlob,
} from '../../platform/browserMediaBlobRegistry';

vi.mock('../../platform/desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: () => true,
}));
vi.mock('../../platform/nativeUrlDownloadAdapter', () => ({ downloadNativeVideo: vi.fn() }));
vi.mock('../../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(async (cacheId) => ({ projectId: `project:${cacheId}` })),
}));
vi.mock('../../platform/nativeMediaOwnership', () => ({
  ensureProjectOwnsNativeMedia: vi.fn(async ({ cacheId, media }) => ({
    assetId: media.assetId,
    cacheId,
    projectId: `project:${cacheId}`,
  })),
  forgetNativeMediaSessionDurably: vi.fn(async () => true),
  persistNativeMediaSession: vi.fn(async session => session),
  readNativeMediaSession: vi.fn(() => null),
}));
vi.mock('../../platform/subtitleProjectBinding', () => ({
  activateSubtitleProjectBinding: vi.fn(),
  clearSubtitleProjectBinding: vi.fn(() => true),
  rollbackSubtitleProjectBinding: vi.fn(() => true),
}));
vi.mock('../../platform/projectService', async (importOriginal) => ({
  ...await importOriginal(),
  deactivateProject: vi.fn(() => true),
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
const sourceB = createNativeMediaDescriptor({
  asset: {
    id: '01890f39-7b62-7c4e-8c9a-000000000102',
    displayName: 'newer.mp4',
    extension: 'mp4',
    sizeBytes: 8192,
    kind: 'video',
  },
  playback: {
    id: '550e8400-e29b-41d4-a716-446655440001',
    playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440001?token=${'b'.repeat(64)}`,
    mimeType: 'video/mp4',
    byteLength: 8192,
  },
});

const completeNativeDownloadTransaction = async (request, media = source) => {
  const cacheId = await generateUrlBasedCacheId.mock.results.at(-1)?.value;
  const projectId = `project:${cacheId}`;
  const binding = await request.admitActivation({
    assetId: media.assetId,
    resolvedProject: {
      cacheId,
      projectId,
      snapshot: {
        metadata: { id: projectId, name: 'Downloaded media' },
        stateVersion: 0,
        media: [],
        tracks: [],
      },
    },
    url: request.url,
  }, { validateOwnership: request.validateOwnership });
  await request.publishActivation(media, binding, {
    validateOwnership: request.validateOwnership,
  });
  return media;
};

beforeEach(() => {
  vi.clearAllMocks();
  forgetNativeMediaSessionDurably.mockResolvedValue(true);
  clearSubtitleProjectBinding.mockImplementation(() => true);
  localStorage.clear();
  clearBrowserMediaBlobs();
  invokeDesktop.mockImplementation(async (command) => {
    if (command === 'get_session_snapshot' || command === 'clear_media') {
      return { media: null, playback: null, subtitleTrack: null };
    }
    throw new Error(`Unexpected desktop command: ${command}`);
  });
  generateUrlBasedCacheId.mockResolvedValue('reviewed');
  downloadNativeVideo.mockImplementation(completeNativeDownloadTransaction);
  activateSubtitleProjectBinding.mockImplementation(async (cacheId, options = {}) => ({
    kind: 'subtitle-project-binding',
    cacheId,
    projectId: options.expectedProjectId ?? `project:${cacheId}`,
    stateVersion: 0,
  }));
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

it('withdraws video A by exact native identity before attempting URL B and leaves no stale preview on failure', async () => {
  invokeDesktop.mockImplementation(async (command, request) => {
    if (command === 'get_session_snapshot') {
      return {
        media: {
          id: SOURCE_ID,
          displayName: 'source.mkv',
          extension: 'mkv',
          sizeBytes: 4096,
          kind: 'video',
        },
        playback: {
          id: source.playbackId,
          playbackUrl: source.playbackUrl,
          mimeType: source.type,
          byteLength: source.size,
        },
        subtitleTrack: null,
      };
    }
    if (command === 'clear_media') {
      expect(request).toEqual({
        expectedAssetId: source.assetId,
        expectedPlaybackId: source.playbackId,
      });
      return { media: null, playback: null, subtitleTrack: null };
    }
    throw new Error(`Unexpected desktop command: ${command}`);
  });
  downloadNativeVideo.mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
    code: 'downloaderRateLimited',
  }));
  localStorage.setItem('current_file_name', 'source.mkv');
  localStorage.setItem('current_file_url', source.playbackUrl);
  localStorage.setItem('current_video_url', 'https://example.test/video-a');
  const setUploadedFile = vi.fn();

  await expect(downloadAndPrepareYouTubeVideo(
    { url: 'https://www.youtube.com/watch?v=video-b' },
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    setUploadedFile,
    vi.fn(),
  )).resolves.toBeUndefined();

  expect(setUploadedFile).toHaveBeenCalledExactlyOnceWith(null);
  expect(localStorage.getItem('current_file_name')).toBeNull();
  expect(localStorage.getItem('current_file_url')).toBeNull();
  expect(localStorage.getItem('current_video_url')).toBeNull();
  expect(invokeDesktop).toHaveBeenCalledWith('clear_media', {
    expectedAssetId: source.assetId,
    expectedPlaybackId: source.playbackId,
  });
});

it('activates the URL project before publishing downloaded media to React', async () => {
  generateUrlBasedCacheId.mockResolvedValue('reviewed');
  const setUploadedFile = vi.fn();
  localStorage.setItem('current_file_url', 'blob:replaced');
  registerBrowserMediaBlob('blob:replaced', new Blob(['old-media']));
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

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

  expect(activateSubtitleProjectBinding).toHaveBeenCalledExactlyOnceWith('reviewed', {
    expectedProjectId: 'project:reviewed',
    create: false,
  });
  expect(activateSubtitleProjectBinding.mock.invocationCallOrder[0])
    .toBeLessThan(setUploadedFile.mock.invocationCallOrder.at(-1));

  // The durable asset-to-project association must land before React ever sees the media, so a
  // later run can reopen exactly this asset under exactly this alias.
  expect(ensureProjectOwnsNativeMedia).toHaveBeenCalledExactlyOnceWith({
    media: source,
    cacheId: 'reviewed',
    expectedProjectId: 'project:reviewed',
  });
  expect(ensureProjectOwnsNativeMedia.mock.invocationCallOrder[0])
    .toBeLessThan(setUploadedFile.mock.invocationCallOrder.at(-1));
  expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:replaced');
  expect(getBrowserMediaBlob('blob:replaced')).toBeNull();
});

it('never revives the replaced browser source when post-publication ownership is lost', async () => {
  const previousBlob = new Blob(['previous-media']);
  localStorage.setItem('current_file_url', 'blob:previous-media');
  localStorage.setItem('current_file_name', 'previous.mp4');
  registerBrowserMediaBlob('blob:previous-media', previousBlob);
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  downloadNativeVideo.mockImplementationOnce(async (request) => {
    const cacheId = await generateUrlBasedCacheId.mock.results.at(-1)?.value;
    const binding = await request.admitActivation({
      assetId: source.assetId,
      resolvedProject: {
        cacheId,
        projectId: `project:${cacheId}`,
        snapshot: {
          metadata: { id: `project:${cacheId}`, name: 'Downloaded media' },
          stateVersion: 0,
          media: [],
          tracks: [],
        },
      },
      url: request.url,
    }, { validateOwnership: request.validateOwnership });
    await request.publishActivation(source, binding, {
      validateOwnership: request.validateOwnership,
    });
    await request.rollbackActivation({ validateOwnership: request.validateOwnership });
    throw new AutoGenerationOwnershipError();
  });
  const setStatus = vi.fn();

  await expect(downloadAndPrepareYouTubeVideo(
    { url: 'https://www.youtube.com/watch?v=reviewed' },
    vi.fn(),
    vi.fn(),
    setStatus,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  )).resolves.toBeUndefined();

  expect(localStorage.getItem('current_file_url')).toBeNull();
  expect(localStorage.getItem('current_file_name')).toBeNull();
  expect(getBrowserMediaBlob('blob:previous-media')).toBeNull();
  expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:previous-media');
});

it('publishes neither compatibility identity nor React media before the binding receipt', async () => {
  generateUrlBasedCacheId.mockResolvedValue('awaited-project');
  let releaseBinding;
  activateSubtitleProjectBinding.mockReturnValueOnce(new Promise((resolve) => {
    releaseBinding = resolve;
  }));
  const setUploadedFile = vi.fn();
  const pending = downloadAndPrepareYouTubeVideo(
    { url: 'https://example.test/awaited' },
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    setUploadedFile,
    vi.fn(),
  );

  await vi.waitFor(() => expect(activateSubtitleProjectBinding).toHaveBeenCalled());
  expect(setUploadedFile).toHaveBeenCalledExactlyOnceWith(null);
  expect(localStorage.getItem('current_file_url')).toBeNull();
  expect(localStorage.getItem('current_file_cache_id')).toBeNull();

  releaseBinding({
    kind: 'subtitle-project-binding',
    cacheId: 'awaited-project',
    projectId: 'project:awaited-project',
  });
  await expect(pending).resolves.toBe(source);
  expect(setUploadedFile.mock.calls).toEqual([[null], [source]]);
});

it('leaves the prepared media unpublished when exact-project binding fails', async () => {
  generateUrlBasedCacheId.mockResolvedValue('failed-project');
  activateSubtitleProjectBinding.mockRejectedValueOnce(new Error('durable binding failed'));
  const setUploadedFile = vi.fn();
  const setStatus = vi.fn();

  await expect(downloadAndPrepareYouTubeVideo(
    { url: 'https://example.test/failure' },
    vi.fn(),
    vi.fn(),
    setStatus,
    vi.fn(),
    vi.fn(),
    setUploadedFile,
    vi.fn(),
  )).resolves.toBeUndefined();

  expect(setUploadedFile).toHaveBeenCalledExactlyOnceWith(null);
  expect(localStorage.getItem('current_file_url')).toBeNull();
  expect(localStorage.getItem('current_file_cache_id')).toBeNull();
  expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
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

it('a manual A download which finishes after B cannot bind, select, or publish A', async () => {
  const acquisitions = [];
  downloadNativeVideo.mockImplementation((request) => new Promise((resolve, reject) => {
    acquisitions.push({ reject, request, resolve });
  }));
  generateUrlBasedCacheId.mockImplementation(async (url) => (
    url.endsWith('/a') ? 'project-a' : 'project-b'
  ));
  const setIsDownloadingA = vi.fn();
  const setIsDownloadingB = vi.fn();
  const setDownloadProgress = vi.fn();
  const setStatus = vi.fn();
  const setCurrentDownloadId = vi.fn();
  const setUploadedFile = vi.fn();
  const commonA = [
    setIsDownloadingA,
    setDownloadProgress,
    setStatus,
    setCurrentDownloadId,
    vi.fn(),
    setUploadedFile,
    vi.fn(),
  ];
  const commonB = [
    setIsDownloadingB,
    setDownloadProgress,
    setStatus,
    setCurrentDownloadId,
    vi.fn(),
    setUploadedFile,
    vi.fn(),
  ];

  const a = downloadAndPrepareYouTubeVideo({ url: 'https://example.test/a' }, ...commonA);
  await vi.waitFor(() => expect(acquisitions).toHaveLength(1));
  const b = downloadAndPrepareYouTubeVideo({ url: 'https://example.test/b' }, ...commonB);
  await vi.waitFor(() => expect(acquisitions).toHaveLength(2));

  const complete = async (acquisition, media, cacheId) => {
    try {
      acquisition.request.validateOwnership();
      const projectId = `project:${cacheId}`;
      const binding = await acquisition.request.admitActivation({
        assetId: media.assetId,
        resolvedProject: {
          cacheId,
          projectId,
          snapshot: {
            metadata: { id: projectId, name: cacheId },
            stateVersion: 0,
            media: [],
            tracks: [],
          },
        },
        url: acquisition.request.url,
      }, { validateOwnership: acquisition.request.validateOwnership });
      await acquisition.request.publishActivation(media, binding, {
        validateOwnership: acquisition.request.validateOwnership,
      });
      acquisition.resolve(media);
    } catch (error) {
      acquisition.reject(error);
    }
  };

  await complete(acquisitions[0], source, 'project-a');
  await expect(a).resolves.toBeUndefined();
  expect(activateSubtitleProjectBinding).not.toHaveBeenCalled();
  expect(ensureProjectOwnsNativeMedia).not.toHaveBeenCalled();
  expect(setUploadedFile.mock.calls).toEqual([[null], [null]]);

  await complete(acquisitions[1], sourceB, 'project-b');
  await expect(b).resolves.toBe(sourceB);
  expect(activateSubtitleProjectBinding).toHaveBeenCalledExactlyOnceWith('project-b', {
    expectedProjectId: 'project:project-b',
    create: false,
  });
  expect(ensureProjectOwnsNativeMedia).toHaveBeenCalledExactlyOnceWith({
    media: sourceB,
    cacheId: 'project-b',
    expectedProjectId: 'project:project-b',
  });
  expect(setUploadedFile.mock.calls).toEqual([[null], [null], [sourceB]]);
  expect(localStorage.getItem('current_video_url')).toBe('https://example.test/b');
  expect(localStorage.getItem('current_file_cache_id')).toBeNull();
  expect(localStorage.getItem('current_file_url')).toBe(sourceB.playbackUrl);
  expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'success' }));
});

it('a delayed workspace-clear reply cannot withdraw the newer completed URL project', async () => {
  let releaseFirstClear;
  forgetNativeMediaSessionDurably.mockReturnValueOnce(new Promise((resolve) => {
    releaseFirstClear = resolve;
  }));
  let currentBinding = 'original';
  clearSubtitleProjectBinding.mockImplementation(() => {
    currentBinding = null;
    return true;
  });
  activateSubtitleProjectBinding.mockImplementation(async (cacheId, options) => {
    currentBinding = cacheId;
    return {
      kind: 'subtitle-project-binding',
      cacheId,
      projectId: options.expectedProjectId,
      stateVersion: 0,
    };
  });
  generateUrlBasedCacheId.mockResolvedValue('newer-project');
  const setUploadedFile = vi.fn();
  const run = (url) => downloadAndPrepareYouTubeVideo(
    { url }, vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), setUploadedFile, vi.fn(),
  );

  const older = run('https://example.test/older');
  await vi.waitFor(() => expect(forgetNativeMediaSessionDurably).toHaveBeenCalledTimes(1));
  await expect(run('https://example.test/newer')).resolves.toBe(source);
  expect(currentBinding).toBe('newer-project');

  releaseFirstClear(true);
  await expect(older).resolves.toBeUndefined();
  expect(currentBinding).toBe('newer-project');
  expect(setUploadedFile).toHaveBeenLastCalledWith(source);
  expect(downloadNativeVideo).toHaveBeenCalledTimes(1);
});

it('does not withdraw or download after native workspace clear loses ownership', async () => {
  forgetNativeMediaSessionDurably.mockResolvedValueOnce(false);
  const setStatus = vi.fn();
  await expect(downloadAndPrepareYouTubeVideo(
    { url: 'https://example.test/superseded' },
    vi.fn(), vi.fn(), setStatus, vi.fn(), vi.fn(), vi.fn(), vi.fn(),
  )).resolves.toBeUndefined();

  expect(clearSubtitleProjectBinding).not.toHaveBeenCalled();
  expect(downloadNativeVideo).not.toHaveBeenCalled();
  expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});
