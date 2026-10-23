import { downloadAndPrepareYouTubeVideo } from '../VideoProcessingHandlers';
import { isNativeMediaDescriptor } from '../../../platform/mediaService';
import { getCachedSubtitles } from '../../../services/subtitleCache';
import { setCurrentCacheId as setRulesCacheId } from '../../../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../../../utils/userSubtitlesStore';
import { resolveProjectForCache } from '../../../platform/subtitleProjectStore';
import {
  assertAutoGenerationContextCurrent,
  createAutoGenerationContext,
  createAutoGenerationRequest,
  getAutoGenerationCacheCandidate,
} from '../../../utils/autoGenerationOwnership';
import { createDownloadHandlers } from './downloadHandlers';
import { updateActiveMedia } from '../../../platform/activeMediaSource';

const nativeMocks = vi.hoisted(() => ({
  session: null,
  resolveOwner: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
}));

vi.mock('../VideoProcessingHandlers', () => ({
  downloadAndPrepareYouTubeVideo: vi.fn(),
}));
vi.mock('../../../platform/mediaService', () => ({
  isNativeMediaDescriptor: vi.fn(),
}));
vi.mock('../../../services/subtitleCache', () => ({
  getCachedSubtitles: vi.fn(),
}));
vi.mock('../../../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(),
}));
vi.mock('../../../platform/nativeMediaOwnership', () => ({
  readNativeMediaSession: () => nativeMocks.session,
  resolveOwnedNativeMediaProject: nativeMocks.resolveOwner,
}));
vi.mock('../../../utils/toastUtils', () => toastMocks);
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
      setCurrentCacheId: vi.fn((cacheId) => { current = cacheId; }),
      subscribeCurrentCacheId: vi.fn(() => () => undefined),
    };
  })(),
}));

const t = (_key, fallback) => fallback;
const URL_CACHE = 'site_media_example_test_clip_mp4';
const PLAYBACK = 'http://127.0.0.1:1/asset/mock?token=mock';

const nativeMedia = (assetId, name = 'clip.mp4') => ({
  __nativeMedia: true,
  assetId,
  name,
  type: 'video/mp4',
  playbackUrl: PLAYBACK,
});

// The upload input / URL download activation commits the native session and binds the subtitle
// project before these handlers run; they only adopt that exact authority.
const ownMedia = (media, cacheId = media.assetId, projectId = `project:${cacheId}`) => {
  nativeMocks.session = Object.freeze({ assetId: media.assetId, cacheId, projectId });
  setRulesCacheId(cacheId);
  setSubtitlesCacheId(cacheId);
};

const buildHandlers = () => {
  const state = {
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
    t,
  };
  return { state, handlers: createDownloadHandlers(state) };
};

beforeEach(() => {
  vi.clearAllMocks();
  nativeMocks.session = null;
  nativeMocks.resolveOwner.mockReset();
  setRulesCacheId(null);
  setSubtitlesCacheId(null);
  vi.clearAllMocks();
  localStorage.clear();
  resolveProjectForCache.mockImplementation(async (cacheId) => ({
    projectId: `project:${cacheId}`,
  }));
  getCachedSubtitles.mockResolvedValue(null);
  isNativeMediaDescriptor.mockImplementation((value) => value?.__nativeMedia === true);
});

test('native auto preparation ignores forged compatibility URL mirrors', async () => {
  const media = nativeMedia('019ffa3a-9a95-7a91-bad8-bd6144abaaeb');
  nativeMocks.resolveOwner.mockResolvedValue({ projectId: `project:${URL_CACHE}` });
  downloadAndPrepareYouTubeVideo.mockImplementation(async () => {
    ownMedia(media, URL_CACHE);
    return media;
  });
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'native-auto', signal: controller.signal });
  const { handlers } = buildHandlers();

  const prepared = await handlers.startBackgroundVideoProcessing(
    { url: 'https://media.example.test/clip.mp4' },
    'youtube',
    request,
  );
  const context = createAutoGenerationContext(prepared);
  updateActiveMedia({ sourceUrl: 'https://wrong.example.test/video' });
  expect(assertAutoGenerationContextCurrent(context)).toBe(context);
});

test('adopts the downloaded media project before reading its cache', async () => {
  const media = nativeMedia('019ffa3a-9a95-7a91-bad8-bd6144abaaeb');
  downloadAndPrepareYouTubeVideo.mockImplementation(async () => {
    ownMedia(media, URL_CACHE);
    return media;
  });
  const { state, handlers } = buildHandlers();

  await expect(handlers.startBackgroundVideoProcessing(
    { url: 'https://media.example.test/clip.mp4' },
    'youtube',
  )).resolves.toBe(media);

  expect(getCachedSubtitles).toHaveBeenCalledWith(
    URL_CACHE,
    'https://media.example.test/clip.mp4',
    { expectedProjectId: `project:${URL_CACHE}` },
  );
  expect(state.setUploadedFileData).toHaveBeenCalledWith(media);
  expect(state.setStatus).toHaveBeenLastCalledWith({});
});

test('a download whose native session does not own the media publishes nothing', async () => {
  const media = nativeMedia('019ffa3a-9a95-7a91-bad8-bd6144abaaeb');
  downloadAndPrepareYouTubeVideo.mockImplementation(async () => {
    ownMedia(nativeMedia('019ffa3a-9a95-7a91-bad8-bd6144abaaec'), URL_CACHE);
    return media;
  });
  const { state, handlers } = buildHandlers();

  await expect(handlers.startBackgroundVideoProcessing(
    { url: 'https://media.example.test/clip.mp4' },
    'youtube',
  )).resolves.toBeNull();

  expect(getCachedSubtitles).not.toHaveBeenCalled();
  expect(state.setUploadedFileData).not.toHaveBeenCalled();
  expect(toastMocks.showErrorToast).not.toHaveBeenCalled();
});

test('adopts the native asset project before local cache lookup', async () => {
  const media = nativeMedia('019ffa3d-8e35-7f92-b3e3-607dd27bb263', 'local.mp4');
  ownMedia(media);
  const { state, handlers } = buildHandlers();

  await expect(handlers.startBackgroundVideoProcessing(media, 'file-upload'))
    .resolves.toBe(media);

  expect(getCachedSubtitles).toHaveBeenCalledWith(media.assetId, null, {
    expectedProjectId: `project:${media.assetId}`,
  });
  expect(state.setUploadedFile).toHaveBeenCalledWith(media);
  expect(state.setUploadedFile.mock.invocationCallOrder[0])
    .toBeLessThan(getCachedSubtitles.mock.invocationCallOrder[0]);
});

test('refuses an upload that is not a native media capability', async () => {
  const { state, handlers } = buildHandlers();
  const browserFile = new File(['x'], 'clip.mp4', { type: 'video/mp4' });

  await expect(handlers.startBackgroundVideoProcessing(browserFile, 'file-upload'))
    .resolves.toBeNull();

  expect(state.setUploadedFile).not.toHaveBeenCalled();
  expect(state.setUploadedFileData).not.toHaveBeenCalled();
  expect(getCachedSubtitles).not.toHaveBeenCalled();
});

test('rejects a URL auto preparation whose alias remaps while the exact cache read is pending', async () => {
  const media = nativeMedia('019ffa4a-9a95-7a91-bad8-bd6144abaaeb');
  let projectId = 'project-a';
  resolveProjectForCache.mockImplementation(async () => ({ projectId }));
  let releaseCache;
  getCachedSubtitles.mockReturnValueOnce(new Promise((resolve) => { releaseCache = resolve; }));
  downloadAndPrepareYouTubeVideo.mockImplementation(async () => {
    ownMedia(media, URL_CACHE, 'project-a');
    return media;
  });
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'url-remap', signal: controller.signal });
  const { state, handlers } = buildHandlers();
  const preparation = handlers.startBackgroundVideoProcessing(
    { url: 'https://media.example.test/clip.mp4' },
    'youtube',
    request,
  );
  const rejected = expect(preparation).rejects.toMatchObject({
    code: 'autoGenerationOwnershipLost',
  });

  await vi.waitFor(() => expect(getCachedSubtitles).toHaveBeenCalledWith(
    URL_CACHE,
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

test('a manual cache read cannot publish media after its project alias remaps', async () => {
  const media = nativeMedia('019ffa4b-9a95-7a91-bad8-bd6144abaaeb');
  let projectId = 'project-a';
  resolveProjectForCache.mockImplementation(async () => ({ projectId }));
  let releaseCache;
  getCachedSubtitles.mockReturnValueOnce(new Promise((resolve) => { releaseCache = resolve; }));
  downloadAndPrepareYouTubeVideo.mockImplementation(async () => {
    ownMedia(media, URL_CACHE, 'project-a');
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

  await expect(preparation).resolves.toBeNull();
  expect(state.setSubtitlesData).not.toHaveBeenCalled();
  expect(state.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }));
  expect(state.setUploadedFileData).not.toHaveBeenCalled();
  expect(toastMocks.showWarningToast).not.toHaveBeenCalled();
});

test('a superseded preparation cannot clear the newer media status when its cache read settles', async () => {
  const first = nativeMedia('019ffa4b-8e35-7f92-b3e3-607dd27bb261', 'first.mp4');
  const second = nativeMedia('019ffa4b-8e35-7f92-b3e3-607dd27bb262', 'second.mp4');
  let releaseFirstCache;
  getCachedSubtitles
    .mockReturnValueOnce(new Promise((resolve) => { releaseFirstCache = resolve; }))
    .mockResolvedValueOnce(null);
  const { state, handlers } = buildHandlers();

  ownMedia(first);
  const stale = handlers.startBackgroundVideoProcessing(first, 'file-upload');
  await vi.waitFor(() => expect(getCachedSubtitles).toHaveBeenCalledTimes(1));
  ownMedia(second);
  await expect(handlers.startBackgroundVideoProcessing(second, 'file-upload'))
    .resolves.toBe(second);
  const statusCallsAfterSecond = state.setStatus.mock.calls.length;
  releaseFirstCache(null);
  await expect(stale).resolves.toBeNull();

  expect(state.setUploadedFileData).toHaveBeenLastCalledWith(second);
  expect(state.setStatus).toHaveBeenLastCalledWith({});
  expect(state.setStatus).toHaveBeenCalledTimes(statusCallsAfterSecond);
  expect(toastMocks.showErrorToast).not.toHaveBeenCalled();
});

test('an optional cache outage warns but keeps media with verified project authority', async () => {
  const media = nativeMedia('019ffa4c-8e35-7f92-b3e3-607dd27bb263', 'local.mp4');
  ownMedia(media);
  getCachedSubtitles.mockRejectedValueOnce(new Error('read unavailable'));
  const { state, handlers } = buildHandlers();

  await expect(handlers.startBackgroundVideoProcessing(media, 'file-upload'))
    .resolves.toBe(media);

  expect(state.setUploadedFileData).toHaveBeenCalledWith(media);
  expect(toastMocks.showWarningToast).toHaveBeenCalledWith(
    'Media is ready, but saved subtitles could not be loaded.'
  );
  expect(toastMocks.showErrorToast).not.toHaveBeenCalled();
});

test('an upload without an owning native session never creates a media-only editor session', async () => {
  const media = nativeMedia('019ffa4e-8e35-7f92-b3e3-607dd27bb263', 'local.mp4');
  const { state, handlers } = buildHandlers();

  await expect(handlers.startBackgroundVideoProcessing(media, 'file-upload'))
    .resolves.toBeNull();

  expect(state.setUploadedFile).not.toHaveBeenCalled();
  expect(state.setUploadedFileData).not.toHaveBeenCalled();
  expect(getCachedSubtitles).not.toHaveBeenCalled();
  expect(state.setStatus).toHaveBeenLastCalledWith({});
});

test('keeps a local auto cache candidate private and immutable until its owner checkpoints it', async () => {
  const media = nativeMedia('019ffa4d-8e35-7f92-b3e3-607dd27bb263', 'local.mp4');
  ownMedia(media);
  const rows = [{ start: 0, end: 1, text: 'Cached' }];
  getCachedSubtitles.mockResolvedValueOnce(rows);
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'local-cache', signal: controller.signal });
  const { state, handlers } = buildHandlers();

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
  const media = nativeMedia('019ffa5a-9a95-7a91-bad8-bd6144abaaeb');
  const url = 'https://media.example.test/clip.mp4';
  downloadAndPrepareYouTubeVideo.mockImplementation(async (selectedVideo, ...args) => {
    const options = args[8];
    options.onSubtitle({
      filename: 'captions.srt',
      language: 'en',
      content: '1\n00:00:00,000 --> 00:00:01,000\nSite subtitle',
    });
    ownMedia(media, URL_CACHE);
    return media;
  });
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'site-subtitle', signal: controller.signal });
  const { state, handlers } = buildHandlers();

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
