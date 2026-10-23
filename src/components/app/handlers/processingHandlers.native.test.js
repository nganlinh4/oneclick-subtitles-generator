import { resolveActiveNativeMedia } from '../../../platform/activeNativeMedia';
import { resetGeminiButtonState } from '../../../utils/geminiEffects';
import { downloadAndPrepareYouTubeVideo } from '../VideoProcessingHandlers';
import { createProcessingHandlers } from './processingHandlers';

vi.mock('../../../platform/activeNativeMedia', () => ({
  resolveActiveNativeMedia: vi.fn(),
}));
vi.mock('../../../platform/mediaService', () => ({
  isNativeMediaDescriptor: vi.fn((value) => value?.__nativeMedia === true),
}));
vi.mock('../../../utils/autoGenerationOwnership', () => ({
  assertAutoGenerationContextCurrent: vi.fn((context) => context),
  isAutoGenerationContext: vi.fn((value) => value?.kind === 'auto-generation-context'),
  isAutoGenerationCompletion: vi.fn((value, context) => (
    value?.kind === 'auto-generation-completion' && value.runId === context.runId
  )),
}));
vi.mock('../../../utils/geminiEffects', () => ({
  resetGeminiButtonState: vi.fn(),
}));
vi.mock('../VideoProcessingHandlers', () => ({
  downloadAndPrepareYouTubeVideo: vi.fn(),
}));

const originalFetch = global.fetch;

const buildHandlers = (overrides = {}) => {
  const values = {
    activeTab: 'manual-retry',
    selectedVideo: null,
    uploadedFile: null,
    apiKeysSet: { gemini: true },
    uploadedFileData: null,
    userProvidedSubtitles: null,
    useUserProvidedSubtitles: false,
    generateSubtitles: vi.fn(),
    retryGeneration: vi.fn().mockResolvedValue(true),
    isRetrying: false,
    setStatus: vi.fn(),
    setIsDownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    setCurrentDownloadId: vi.fn(),
    setIsSrtOnlyMode: vi.fn(),
    setUploadedFile: vi.fn(),
    setUploadedFileData: vi.fn(),
    setIsRetrying: vi.fn(),
    setSelectedSegment: vi.fn(),
    setShowProcessingModal: vi.fn(),
    setIsProcessingSegment: vi.fn(),
    handleTabChange: vi.fn(),
    t: (_key, fallback) => fallback,
    ...overrides,
  };
  return { values, handlers: createProcessingHandlers(values) };
};

beforeEach(() => {
  resolveActiveNativeMedia.mockReset();
  downloadAndPrepareYouTubeVideo.mockReset();
  resetGeminiButtonState.mockReset();
  global.fetch = vi.fn();
  localStorage.clear();
  delete window.subtitlesData;
});

afterAll(() => {
  global.fetch = originalFetch;
});

test('desktop retry preserves the durable project track until replacement succeeds', async () => {
  const media = Object.freeze({ __nativeMedia: true, assetId: 'asset-id' });
  resolveActiveNativeMedia.mockResolvedValue({
    cacheId: 'cache-id', projectId: 'project-id', media,
  });
  const { values, handlers } = buildHandlers();

  await expect(handlers.handleRetryGeneration()).resolves.toBe(true);

  expect(global.fetch).not.toHaveBeenCalled();
  expect(values.retryGeneration).toHaveBeenCalledWith(
    media,
    'file-upload',
    { gemini: true },
    {}
  );
});

test('successful URL retry publishes its outcome and always releases retry lifecycle state', async () => {
  resolveActiveNativeMedia.mockRejectedValue(new Error('not downloaded yet'));
  const downloaded = Object.freeze({ __nativeMedia: true, assetId: 'downloaded' });
  downloadAndPrepareYouTubeVideo.mockResolvedValue(downloaded);
  const { values, handlers } = buildHandlers({
    activeTab: 'unified-url',
    selectedVideo: { url: 'https://example.test/video' },
  });

  await expect(handlers.handleRetryGeneration()).resolves.toBe(true);

  expect(values.retryGeneration).toHaveBeenCalledWith(
    downloaded,
    'file-upload',
    { gemini: true },
    {},
  );
  expect(values.setIsRetrying).toHaveBeenNthCalledWith(1, true);
  expect(values.setIsRetrying).toHaveBeenLastCalledWith(false);
  expect(resetGeminiButtonState).toHaveBeenCalledTimes(1);
});

test.each([true, false])('returns the real generation outcome (%s) to awaited callers', async (generated) => {
  const videoFile = { assetId: 'asset-1', type: 'video/mp4' };
  const generateSubtitles = vi.fn().mockResolvedValue(generated);
  const { handlers } = buildHandlers({ generateSubtitles });

  await expect(handlers.handleProcessWithOptions({
    videoFile,
    segment: { start: 0, end: 10 },
    method: 'old',
    inlineExtraction: true,
  })).resolves.toBe(generated);

  expect(generateSubtitles).toHaveBeenCalledWith(
    videoFile,
    'file-upload',
    { gemini: true },
    expect.objectContaining({
      segment: { start: 0, end: 10 },
      method: 'old',
      inlineExtraction: true,
    }),
  );
});

test('ordinary semi-auto processing prefers the modal media over a stale captured upload', async () => {
  const staleMedia = { assetId: 'asset-stale', type: 'video/mp4' };
  const preparedMedia = { assetId: 'asset-prepared', type: 'video/mp4' };
  const generateSubtitles = vi.fn().mockResolvedValue(true);
  const { handlers } = buildHandlers({ uploadedFileData: staleMedia, generateSubtitles });

  await expect(handlers.handleProcessWithOptions({
    videoFile: preparedMedia,
    segment: { start: 4, end: 9 },
    method: 'old',
    inlineExtraction: true,
  })).resolves.toBe(true);

  expect(generateSubtitles).toHaveBeenCalledWith(
    preparedMedia,
    'file-upload',
    { gemini: true },
    expect.objectContaining({ segment: { start: 4, end: 9 } }),
  );
});

test('full-auto keeps the stored context choice and returns only the exact generation receipt', async () => {
  const media = { assetId: 'asset-prepared', type: 'video/mp4' };
  const autoRunContext = {
    kind: 'auto-generation-context',
    runId: 'run-1',
    media,
    signal: new AbortController().signal,
  };
  const receipt = { kind: 'auto-generation-completion', runId: 'run-1' };
  const generateSubtitles = vi.fn().mockResolvedValue(receipt);
  localStorage.setItem('video_processing_use_outside_context', 'true');
  const promptContext = Object.freeze({ presetId: 'settings', useOutsideResultsContext: false });
  const { handlers } = buildHandlers({ uploadedFileData: { assetId: 'stale' }, generateSubtitles });

  await expect(handlers.handleProcessWithOptions({
    videoFile: media,
    segment: { start: 0, end: 20 },
    generationScope: 'full-media',
    method: 'old',
    inlineExtraction: true,
    promptContext,
    autoRunContext,
  })).resolves.toBe(receipt);

  // The run carries its own (context-free) prompt inputs; the user's toggle is not rewritten.
  expect(localStorage.getItem('video_processing_use_outside_context')).toBe('true');
  expect(generateSubtitles).toHaveBeenCalledWith(
    media,
    'file-upload',
    { gemini: true },
    expect.objectContaining({
      segment: undefined,
      requestedSegment: { start: 0, end: 20 },
      generationScope: 'full-media',
      promptContext,
      autoRunContext,
    }),
  );
});

test('an auto stop ends processing without publishing a false failure status', async () => {
  const media = { assetId: 'asset-prepared', type: 'video/mp4' };
  const controller = new AbortController();
  const autoRunContext = {
    kind: 'auto-generation-context',
    runId: 'run-stop',
    media,
    signal: controller.signal,
  };
  const generateSubtitles = vi.fn().mockImplementation(async () => {
    controller.abort();
    throw new DOMException('Stopped', 'AbortError');
  });
  const { values, handlers } = buildHandlers({ generateSubtitles });

  await expect(handlers.handleProcessWithOptions({
    videoFile: media,
    generationScope: 'full-media',
    segment: { start: 0, end: 20 },
    method: 'old',
    autoRunContext,
  })).resolves.toBe(false);

  expect(values.setStatus).not.toHaveBeenCalled();
  expect(values.setIsProcessingSegment).toHaveBeenLastCalledWith(false);
});
