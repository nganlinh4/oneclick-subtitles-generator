import { isDesktopRuntime } from '../../../platform/runtimeEnvironment';
import { clearProjectSubtitles } from '../../../platform/subtitleProjectStore';
import { createProcessingHandlers } from './processingHandlers';

vi.mock('../../../platform/runtimeEnvironment', () => ({
  isDesktopRuntime: vi.fn(),
}));
vi.mock('../../../platform/subtitleProjectStore', () => ({
  clearProjectSubtitles: vi.fn(),
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
    retryGeneration: vi.fn().mockResolvedValue(undefined),
    isRetrying: false,
    setStatus: vi.fn(),
    setSubtitlesData: vi.fn(),
    setIsDownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    setCurrentDownloadId: vi.fn(),
    setIsSrtOnlyMode: vi.fn(),
    setUploadedFile: vi.fn(),
    setUploadedFileData: vi.fn(),
    setIsRetrying: vi.fn(),
    setSegmentsStatus: vi.fn(),
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
  isDesktopRuntime.mockReset();
  clearProjectSubtitles.mockReset().mockResolvedValue(true);
  global.fetch = vi.fn();
  localStorage.clear();
  delete window.subtitlesData;
});

afterAll(() => {
  global.fetch = originalFetch;
});

test('desktop retry clears the durable project track and never reaches legacy HTTP', async () => {
  isDesktopRuntime.mockReturnValue(true);
  localStorage.setItem('current_file_cache_id', 'cache-id');
  const { values, handlers } = buildHandlers();

  await handlers.handleRetryGeneration();

  expect(clearProjectSubtitles).toHaveBeenCalledWith('cache-id');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(values.retryGeneration).toHaveBeenCalledWith(
    null,
    'retry',
    { gemini: true },
    {}
  );
  expect(values.setSubtitlesData).toHaveBeenCalledWith(null);
});

test('browser retry never revives the retired localhost deletion request', async () => {
  isDesktopRuntime.mockReturnValue(false);
  localStorage.setItem('current_file_cache_id', 'cache-id');
  const { handlers } = buildHandlers();

  await handlers.handleRetryGeneration();

  expect(clearProjectSubtitles).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});
