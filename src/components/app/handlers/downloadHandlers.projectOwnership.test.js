import { downloadAndPrepareYouTubeVideo } from '../VideoProcessingHandlers';
import { isNativeMediaDescriptor } from '../../../platform/mediaService';
import {
  generateUrlBasedCacheId,
  getCachedSubtitles,
} from '../../../services/subtitleCache';
import { setCurrentCacheId as setRulesCacheId } from '../../../utils/transcriptionRulesStore';
import {
  refreshCurrentSubtitleProject,
  setCurrentCacheId as setSubtitlesCacheId,
} from '../../../utils/userSubtitlesStore';
import { resolveProjectForCache } from '../../../platform/subtitleProjectStore';
import {
  createAutoGenerationContext,
  createAutoGenerationRequest,
  getAutoGenerationCacheCandidate,
} from '../../../utils/autoGenerationOwnership';
import { createDownloadHandlers } from './downloadHandlers';

vi.mock('../VideoProcessingHandlers', () => ({
  downloadAndPrepareYouTubeVideo: vi.fn(),
}));
vi.mock('../../../platform/mediaService', () => ({
  isNativeMediaDescriptor: vi.fn(),
}));
vi.mock('../../../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(),
  getCachedSubtitles: vi.fn(),
}));
vi.mock('../../../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(async (cacheId) => ({ projectId: `project:${cacheId}` })),
}));
vi.mock('../../../utils/transcriptionRulesStore', () => ({
  ...(() => {
    let current = null;
    return {
      getCurrentCacheId: vi.fn(() => current),
      setCurrentCacheId: vi.fn((cacheId) => { current = cacheId; }),
    };
  })(),
}));
vi.mock('../../../utils/userSubtitlesStore', () => ({
  ...(() => {
    let current = null;
    return {
      getCurrentCacheId: vi.fn(() => current),
      refreshCurrentSubtitleProject: vi.fn(),
      setCurrentCacheId: vi.fn((cacheId) => { current = cacheId; }),
      subscribeCurrentCacheId: vi.fn(() => () => undefined),
    };
  })(),
}));

const t = (_key, fallback) => fallback;

const buildHandlers = () => {
  const state = {
    selectedVideo: { url: 'https://media.example.test/clip.mp4' },
    setStatus: vi.fn(),
    setSubtitlesData: vi.fn(),
    setIsDownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    setCurrentDownloadId: vi.fn(),
    setIsSrtOnlyMode: vi.fn(),
    setActiveTab: vi.fn(),
    setUploadedFile: vi.fn(),
    setIsUploading: vi.fn(),
    setUploadedFileData: vi.fn(),
    pendingAutoSubtitleRef: { current: null },
    handleSrtUpload: vi.fn(),
    handleTabChange: vi.fn(),
    t,
  };
  return { state, handlers: createDownloadHandlers(state) };
};

beforeEach(() => {
  vi.clearAllMocks();
  setRulesCacheId(null);
  setSubtitlesCacheId(null);
  vi.clearAllMocks();
  localStorage.clear();
  resolveProjectForCache.mockImplementation(async (cacheId) => ({
    projectId: `project:${cacheId}`,
  }));
  getCachedSubtitles.mockResolvedValue(null);
  generateUrlBasedCacheId.mockResolvedValue('site_media_example_test_clip_mp4');
  isNativeMediaDescriptor.mockReturnValue(true);
});

test('refreshes authoritative subtitle state when a repeated URL keeps the same alias', async () => {
  const media = {
    __nativeMedia: true,
    assetId: '019ffa3a-9a95-7a91-bad8-bd6144abaaeb',
    name: 'clip.mp4',
    type: 'video/mp4',
    playbackUrl: 'http://127.0.0.1:1/asset/mock?token=mock',
  };
  downloadAndPrepareYouTubeVideo.mockImplementation(async (selectedVideo) => {
    localStorage.setItem('current_video_url', selectedVideo.url);
    return media;
  });
  const { handlers } = buildHandlers();
  const request = { url: 'https://media.example.test/clip.mp4' };

  await handlers.startBackgroundVideoProcessing(request, 'youtube');
  await handlers.startBackgroundVideoProcessing(request, 'youtube');

  expect(refreshCurrentSubtitleProject)
    .toHaveBeenCalledExactlyOnceWith('site_media_example_test_clip_mp4');
});

test('activates the URL project before reading cache or exposing prepared native media', async () => {
  const media = {
    __nativeMedia: true,
    assetId: '019ffa3a-9a95-7a91-bad8-bd6144abaaeb',
    name: 'clip.mp4',
    type: 'video/mp4',
    playbackUrl: 'http://127.0.0.1:1/asset/mock?token=mock',
  };
  downloadAndPrepareYouTubeVideo.mockImplementation(async (selectedVideo) => {
    localStorage.setItem('current_video_url', selectedVideo.url);
    return media;
  });
  const { state, handlers } = buildHandlers();

  await expect(handlers.startBackgroundVideoProcessing(
    { url: 'https://media.example.test/clip.mp4' },
    'youtube',
  )).resolves.toBe(media);

  expect(generateUrlBasedCacheId).toHaveBeenCalledWith('https://media.example.test/clip.mp4');
  expect(setRulesCacheId).toHaveBeenCalledWith('site_media_example_test_clip_mp4');
  expect(setSubtitlesCacheId).toHaveBeenCalledWith('site_media_example_test_clip_mp4');
  expect(getCachedSubtitles).toHaveBeenCalledWith(
    'site_media_example_test_clip_mp4',
    'https://media.example.test/clip.mp4',
    { expectedProjectId: 'project:site_media_example_test_clip_mp4' },
  );
  expect(setRulesCacheId.mock.invocationCallOrder[0])
    .toBeLessThan(getCachedSubtitles.mock.invocationCallOrder[0]);
  expect(setSubtitlesCacheId.mock.invocationCallOrder[0])
    .toBeLessThan(state.setUploadedFileData.mock.invocationCallOrder[0]);
});

test('activates the native asset project before local cache lookup', async () => {
  const media = {
    __nativeMedia: true,
    assetId: '019ffa3d-8e35-7f92-b3e3-607dd27bb263',
    name: 'local.mp4',
    type: 'video/mp4',
    playbackUrl: 'http://127.0.0.1:1/asset/mock?token=mock',
  };
  const { state, handlers } = buildHandlers();

  await expect(handlers.startBackgroundVideoProcessing(media, 'file-upload'))
    .resolves.toBe(media);

  expect(setRulesCacheId).toHaveBeenCalledWith(media.assetId);
  expect(setSubtitlesCacheId).toHaveBeenCalledWith(media.assetId);
  expect(getCachedSubtitles).toHaveBeenCalledWith(media.assetId, null, {
    expectedProjectId: `project:${media.assetId}`,
  });
  expect(setRulesCacheId.mock.invocationCallOrder[0])
    .toBeLessThan(getCachedSubtitles.mock.invocationCallOrder[0]);
  expect(setSubtitlesCacheId.mock.invocationCallOrder[0])
    .toBeLessThan(state.setUploadedFileData.mock.invocationCallOrder[0]);
});

test('rejects a URL auto preparation whose alias remaps while the exact cache read is pending', async () => {
  const media = {
    __nativeMedia: true,
    assetId: '019ffa4a-9a95-7a91-bad8-bd6144abaaeb',
    name: 'clip.mp4',
    type: 'video/mp4',
    playbackUrl: 'http://127.0.0.1:1/asset/mock?token=mock',
  };
  let projectId = 'project-a';
  resolveProjectForCache.mockImplementation(async () => ({ projectId }));
  let releaseCache;
  getCachedSubtitles.mockReturnValueOnce(new Promise((resolve) => { releaseCache = resolve; }));
  downloadAndPrepareYouTubeVideo.mockImplementation(async (selectedVideo) => {
    localStorage.setItem('current_video_url', selectedVideo.url);
    localStorage.setItem('current_file_cache_id', media.assetId);
    return media;
  });
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'url-remap', signal: controller.signal });
  const { state, handlers } = buildHandlers();
  localStorage.setItem('current_video_url', 'https://media.example.test/clip.mp4');
  const preparation = handlers.startBackgroundVideoProcessing(
    { url: 'https://media.example.test/clip.mp4' },
    'youtube',
    request,
  );
  const rejected = expect(preparation).rejects.toMatchObject({
    code: 'autoGenerationOwnershipLost',
  });

  await vi.waitFor(() => expect(getCachedSubtitles).toHaveBeenCalledWith(
    'site_media_example_test_clip_mp4',
    'https://media.example.test/clip.mp4',
    { expectedProjectId: 'project-a' },
  ));
  projectId = 'project-b';
  releaseCache([{ start: 0, end: 1, text: 'Wrong project' }]);

  await rejected;
  expect(state.setSubtitlesData).not.toHaveBeenCalled();
  expect(state.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  expect(state.setUploadedFileData).not.toHaveBeenCalled();
});

test('a manual cache read never publishes rows from an alias remapped during the read', async () => {
  const media = {
    __nativeMedia: true,
    assetId: '019ffa4b-9a95-7a91-bad8-bd6144abaaeb',
    name: 'clip.mp4',
    type: 'video/mp4',
    playbackUrl: 'http://127.0.0.1:1/asset/mock?token=mock',
  };
  let projectId = 'project-a';
  resolveProjectForCache.mockImplementation(async () => ({ projectId }));
  let releaseCache;
  getCachedSubtitles.mockReturnValueOnce(new Promise((resolve) => { releaseCache = resolve; }));
  downloadAndPrepareYouTubeVideo.mockImplementation(async (selectedVideo) => {
    localStorage.setItem('current_video_url', selectedVideo.url);
    return media;
  });
  const { state, handlers } = buildHandlers();
  const preparation = handlers.startBackgroundVideoProcessing(
    { url: 'https://media.example.test/clip.mp4' },
    'youtube',
  );

  await vi.waitFor(() => expect(getCachedSubtitles).toHaveBeenCalled());
  projectId = 'project-b';
  releaseCache([{ start: 0, end: 1, text: 'Wrong project' }]);

  await expect(preparation).resolves.toBe(media);
  expect(state.setSubtitlesData).not.toHaveBeenCalled();
  expect(state.setStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  expect(state.setUploadedFileData).toHaveBeenCalledWith(media);
});

test('keeps a local auto cache candidate private and immutable until its owner checkpoints it', async () => {
  const media = {
    __nativeMedia: true,
    assetId: '019ffa4d-8e35-7f92-b3e3-607dd27bb263',
    name: 'local.mp4',
    type: 'video/mp4',
    playbackUrl: 'http://127.0.0.1:1/asset/mock?token=mock',
  };
  const rows = [{ start: 0, end: 1, text: 'Cached' }];
  getCachedSubtitles.mockResolvedValueOnce(rows);
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'local-cache', signal: controller.signal });
  const { state, handlers } = buildHandlers();
  localStorage.setItem('current_file_cache_id', media.assetId);

  const prepared = await handlers.startBackgroundVideoProcessing(media, 'file-upload', request);
  const candidate = getAutoGenerationCacheCandidate(createAutoGenerationContext(prepared));
  rows[0].text = 'Mutated after preparation';

  expect(candidate).toEqual({
    cacheHit: true,
    subtitles: [{ start: 0, end: 1, text: 'Cached' }],
  });
  expect(Object.isFrozen(candidate)).toBe(true);
  expect(Object.isFrozen(candidate.subtitles)).toBe(true);
  expect(Object.isFrozen(candidate.subtitles[0])).toBe(true);
  expect(state.setSubtitlesData).not.toHaveBeenCalled();
  expect(state.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

test('keeps downloaded site subtitles private instead of invoking the green upload UI', async () => {
  const media = {
    __nativeMedia: true,
    assetId: '019ffa5a-9a95-7a91-bad8-bd6144abaaeb',
    name: 'clip.mp4',
    type: 'video/mp4',
    playbackUrl: 'http://127.0.0.1:1/asset/mock?token=mock',
  };
  const url = 'https://media.example.test/clip.mp4';
  downloadAndPrepareYouTubeVideo.mockImplementation(async (selectedVideo, ...args) => {
    const options = args[8];
    options.onSubtitle({
      filename: 'captions.srt',
      language: 'en',
      content: '1\n00:00:00,000 --> 00:00:01,000\nSite subtitle',
    });
    localStorage.setItem('current_video_url', selectedVideo.url);
    localStorage.setItem('current_file_cache_id', media.assetId);
    return media;
  });
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'site-subtitle', signal: controller.signal });
  const { state, handlers } = buildHandlers();
  localStorage.setItem('current_video_url', url);

  const prepared = await handlers.startBackgroundVideoProcessing({ url }, 'youtube', request);
  const candidate = getAutoGenerationCacheCandidate(createAutoGenerationContext(prepared));

  expect(candidate).toMatchObject({
    cacheHit: true,
    subtitles: [{ id: 1, start: 0, end: 1, text: 'Site subtitle' }],
  });
  expect(state.handleSrtUpload).not.toHaveBeenCalled();
  expect(state.setSubtitlesData).not.toHaveBeenCalled();
  expect(state.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});
