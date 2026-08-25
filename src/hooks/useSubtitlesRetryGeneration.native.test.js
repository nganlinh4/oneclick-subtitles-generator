import { act, renderHook } from '@testing-library/react';
import { useSubtitlesRetryGeneration } from './useSubtitlesRetryGeneration';
import { getVideoDuration, processMediaFile } from '../utils/videoProcessor';
import { processGeminiSegment } from '../services/engines/GeminiAdapter';
import { saveSubtitlesToCache } from '../services/subtitleCache';
import {
  refreshActiveNativeMedia,
  resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';

vi.mock('../utils/videoProcessor', () => ({
  getVideoDuration: vi.fn(),
  processMediaFile: vi.fn(),
}));
vi.mock('../services/engines/GeminiAdapter', () => ({
  processGeminiSegment: vi.fn(),
}));
vi.mock('../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('./useSubtitlesCaching', () => ({
  resolveCacheIdForGeneration: vi.fn(async () => 'cache-native'),
}));
vi.mock('../platform/activeNativeMedia', () => ({
  refreshActiveNativeMedia: vi.fn(),
  resolveActiveNativeMedia: vi.fn(),
}));
vi.mock('../services/subtitleCache', () => ({
  saveSubtitlesToCache: vi.fn(),
  requireSuccessfulSubtitleCacheSave: vi.fn((receipt) => {
    if (receipt?.success !== true) throw receipt?.error ?? new Error('save failed');
  }),
  isSuccessfulSubtitleCacheSaveReceipt: vi.fn((receipt) => receipt?.success === true),
  isDurableSubtitleCheckpointReceipt: vi.fn(() => false),
}));
vi.mock('../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(async () => ({
    projectId: 'project-native',
    snapshot: { metadata: { id: 'project-native' }, stateVersion: 2 },
  })),
  loadExactProjectSubtitles: vi.fn(async () => []),
}));
vi.mock('../platform/projectService', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProject: vi.fn(async () => ({
    metadata: { id: 'project-native' },
    stateVersion: 2,
  })),
}));
vi.mock('../utils/transcriptionRulesStore', () => ({
  getCurrentCacheId: vi.fn(() => 'cache-native'),
}));
vi.mock('../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: vi.fn(() => 'cache-native'),
}));
vi.mock('../services/geminiService', () => ({
  callGeminiApi: vi.fn(),
  setProcessingForceStopped: vi.fn(),
}));

const media = Object.freeze({
  __nativeMedia: true,
  assetId: '01890f39-7b62-7c4e-8c9a-000000000101',
  playbackId: '550e8400-e29b-41d4-a716-446655440000',
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4096,
  lastModified: 0,
  playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('gemini_model', 'gemini-3.1-flash-lite');
  const capability = Object.freeze({
    projectId: 'project-native',
    stateVersion: 2,
    cacheId: 'cache-native',
    assetId: media.assetId,
    media,
  });
  resolveActiveNativeMedia.mockResolvedValue(capability);
  refreshActiveNativeMedia.mockResolvedValue(capability);
  getVideoDuration.mockResolvedValue(7.25);
  processGeminiSegment.mockImplementation(async (_input, _segment, _options, hooks) => {
    hooks.onStreamingUpdate([{ start: 0, end: 1, text: 'partial' }], true);
    return [{ start: 0, end: 2, text: 'complete' }];
  });
  saveSubtitlesToCache.mockImplementation(async (_cacheId, rows) => ({
    success: true,
    cacheId: 'cache-native',
    projectId: 'project-native',
    subtitleCount: rows.length,
  }));
});

test('streams a full native retry and preserves the exact inspected duration', async () => {
  const setStatus = vi.fn();
  const setIsGenerating = vi.fn();
  const setSubtitlesData = vi.fn();
  const currentSourceFileRef = { current: null };
  const { result } = renderHook(() => useSubtitlesRetryGeneration({
    t: (_key, fallback) => fallback,
    setStatus,
    setIsGenerating,
    setSubtitlesData,
    currentSourceFileRef,
  }));

  let succeeded;
  await act(async () => {
    succeeded = await result.current.retryGeneration(media, 'file-upload', { gemini: true });
  });

  expect(succeeded).toBe(true);
  expect(processMediaFile).not.toHaveBeenCalled();
  expect(processGeminiSegment).toHaveBeenCalledTimes(1);
  expect(processGeminiSegment.mock.calls[0][0]).toBe(media);
  expect(processGeminiSegment.mock.calls[0][1]).toEqual({ start: 0, end: 7.25 });
  expect(processGeminiSegment.mock.calls[0][2]).toEqual(expect.objectContaining({
    projectId: 'project-native',
    expectedProjectStateVersion: 2,
  }));
  expect(processGeminiSegment.mock.calls[0][3].onStreamingUpdate).toEqual(expect.any(Function));
  expect(setSubtitlesData).toHaveBeenNthCalledWith(1, [{ start: 0, end: 1, text: 'partial' }]);
  expect(setSubtitlesData).toHaveBeenCalledTimes(2);
  expect(setSubtitlesData).toHaveBeenLastCalledWith([{ start: 0, end: 2, text: 'complete' }]);
  expect(currentSourceFileRef.current).toBe(media);
});

test('does not hide a failed native duration behind a nonstreaming fallback', async () => {
  getVideoDuration.mockRejectedValue(new Error('duration unavailable'));
  const setStatus = vi.fn();
  const { result } = renderHook(() => useSubtitlesRetryGeneration({
    t: (_key, fallback) => fallback,
    setStatus,
    setIsGenerating: vi.fn(),
    setSubtitlesData: vi.fn(),
    currentSourceFileRef: { current: null },
  }));

  let succeeded;
  await act(async () => {
    succeeded = await result.current.retryGeneration(media, 'file-upload', { gemini: true });
  });

  expect(succeeded).toBe(false);
  expect(processGeminiSegment).not.toHaveBeenCalled();
  expect(processMediaFile).not.toHaveBeenCalled();
  expect(setStatus).toHaveBeenLastCalledWith({
    message: 'Error: duration unavailable',
    type: 'error',
  });
});

test('reports a durable-save failure separately from Gemini generation', async () => {
  const failure = Object.assign(new Error('Subtitles could not be saved.'), {
    code: 'subtitleCacheSaveFailed',
  });
  saveSubtitlesToCache.mockResolvedValueOnce({ success: false, error: failure });
  const setStatus = vi.fn();
  const setSubtitlesData = vi.fn();
  const { result } = renderHook(() => useSubtitlesRetryGeneration({
    t: (_key, fallback) => fallback,
    setStatus,
    setIsGenerating: vi.fn(),
    setSubtitlesData,
    currentSourceFileRef: { current: null },
  }));

  let succeeded;
  await act(async () => {
    succeeded = await result.current.retryGeneration(media, 'file-upload', { gemini: true });
  });

  expect(succeeded).toBe(false);
  expect(setStatus).toHaveBeenLastCalledWith({
    message: 'Subtitles were generated, but they could not be saved.',
    type: 'error',
  });
  expect(setSubtitlesData).toHaveBeenNthCalledWith(1, [{ start: 0, end: 1, text: 'partial' }]);
  expect(setSubtitlesData).toHaveBeenLastCalledWith([]);
});
