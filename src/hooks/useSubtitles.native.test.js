import { act, renderHook } from '@testing-library/react';
import useSubtitles from './useSubtitles';
import { callGeminiApi } from '../services/geminiService';
import { getVideoDuration } from '../utils/videoProcessor';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';

vi.mock('../services/geminiService', () => ({
  callGeminiApi: vi.fn(),
  setProcessingForceStopped: vi.fn(),
}));
vi.mock('../utils/videoProcessor', () => ({ getVideoDuration: vi.fn() }));
vi.mock('../services/engines/GeminiAdapter', () => ({ processGeminiSegment: vi.fn() }));
vi.mock('../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('./useSubtitlesCaching', () => ({
  resolveCacheIdForGeneration: vi.fn().mockResolvedValue('native-cache-id'),
  loadCachedSubtitlesIfAvailable: vi.fn().mockResolvedValue({ cacheHit: false }),
}));
vi.mock('./useNativeSubtitleHydration', () => ({ useNativeSubtitleHydration: vi.fn() }));
vi.mock('./useQuotaCountdown', () => ({
  useQuotaCountdown: () => ({ startQuotaCountdown: vi.fn() }),
}));
vi.mock('./useSubtitlesRetryGeneration', () => ({
  useSubtitlesRetryGeneration: () => ({ retryGeneration: vi.fn() }),
}));
vi.mock('./useSubtitlesSegmentRetry', () => ({
  useSubtitlesSegmentRetry: () => ({ retrySegment: vi.fn() }),
}));
vi.mock('../events/bus', () => ({
  EVENTS: { SEGMENT_STATUS_UPDATE: 'segment-status-update' },
  subscribe: () => () => undefined,
}));
vi.mock('../utils/geminiSubtitleErrors', () => ({
  reportKnownGeminiSubtitleError: () => false,
}));

const media = Object.freeze({
  __nativeMedia: true,
  assetId: '01890f39-7b62-7c4e-8c9a-000000000201',
  playbackId: '550e8400-e29b-41d4-a716-446655440001',
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4096,
  lastModified: 0,
  playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440001?token=${'a'.repeat(64)}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  getVideoDuration.mockResolvedValue(12);
});

test('does not hide a native streaming failure behind a second Gemini request', async () => {
  processGeminiSegment.mockRejectedValueOnce(new Error('native streaming failed'));
  const { result } = renderHook(() => useSubtitles((_key, fallback) => fallback ?? _key));

  let succeeded;
  await act(async () => {
    succeeded = await result.current.generateSubtitles(
      media,
      'file-upload',
      { gemini: true },
      { method: 'new', model: 'gemini-3.1-flash-lite', fps: 1, mediaResolution: '360p' }
    );
  });

  expect(succeeded).toBe(false);
  expect(processGeminiSegment).toHaveBeenCalledTimes(1);
  expect(callGeminiApi).not.toHaveBeenCalled();
  expect(result.current.status).toEqual({
    message: 'Error: native streaming failed',
    type: 'error',
  });
});
