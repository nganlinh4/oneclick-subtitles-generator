import { streamGeminiApiWithFilesApi } from '../../services/gemini';
import { processSegmentWithStreaming } from './processingUtils';

vi.mock('../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../platform/mediaService', () => ({
  isNativeMediaDescriptor: (value) => value?.__nativeMedia === true,
}));
vi.mock('../../services/gemini', () => ({
  streamGeminiApiInline: vi.fn(),
  streamGeminiApiWithFilesApi: vi.fn(),
}));

it('routes native segment processing through the clipping-aware core and restores absolute times', async () => {
  const media = Object.freeze({
    __nativeMedia: true,
    assetId: '01890f39-7b62-7c4e-8c9a-000000000101',
    name: 'source.mp4',
    type: 'video/mp4',
  });
  const segment = { start: 10, end: 20 };
  const onSubtitleUpdate = vi.fn();
  const setStatus = vi.fn();
  const completed = vi.fn();
  window.addEventListener('streaming-complete', completed);
  streamGeminiApiWithFilesApi.mockImplementation((
    _media, _options, onChunk, onComplete
  ) => {
    onChunk({
      accumulatedText: '[{"startTime":"00m01s000ms","endTime":"00m02s000ms","text":"relative"},',
    });
    onChunk({
      accumulatedText: '[{"startTime":"00m01s000ms","endTime":"00m02s000ms","text":"relative"},{"startTime":"00m09s000ms","endTime":"00m10s000ms","text":"clamped"}]',
    });
    onComplete([
      { start: 1, end: 2, text: 'relative' },
      { start: 9, end: 10, text: 'clamped' },
    ]);
  });

  const result = await processSegmentWithStreaming(
    media,
    segment,
    { model: 'gemini-3.5-flash-lite', mediaResolution: 'medium', runId: 'run-1' },
    setStatus,
    onSubtitleUpdate,
    (_key, fallback, values = {}) => Object.entries(values).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
      fallback,
    )
  );

  expect(streamGeminiApiWithFilesApi).toHaveBeenCalledWith(media, {
    userProvidedSubtitles: undefined,
    modelId: 'gemini-3.5-flash-lite',
    mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
    maxDurationPerRequest: undefined,
    segmentProcessingDelay: undefined,
    autoSplitSubtitles: undefined,
    maxWordsPerSubtitle: undefined,
    t: expect.any(Function),
    segmentInfo: { start: 10, end: 20, duration: 10 },
    videoMetadata: { start_offset: '10s', end_offset: '20s', fps: undefined },
    runId: 'run-1',
  }, expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Function));
  expect(result).toEqual([
    { start: 11, end: 12, text: 'relative' },
    { start: 19, end: 20, text: 'clamped' },
  ]);
  expect(onSubtitleUpdate).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ start: 11, end: 12, text: 'relative' }),
    ]),
    true,
  );
  expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  expect(completed).not.toHaveBeenCalled();
  window.removeEventListener('streaming-complete', completed);
}, 15_000);

it('fails closed instead of reaching browser provider streaming with non-native media', async () => {
  await expect(processSegmentWithStreaming(
    { name: 'stale.mp4', type: 'video/mp4' },
    { start: 0, end: 5 },
    { model: 'gemini-3.5-flash-lite' },
    vi.fn(),
    vi.fn(),
    vi.fn()
  )).rejects.toThrow('Select the media again before starting native Gemini transcription.');
});
