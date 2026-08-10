import { callGeminiApi } from '../../services/gemini';
import { showSuccessToast } from '../toastUtils';
import { processSegmentWithStreaming } from './processingUtils';

vi.mock('../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../platform/mediaService', () => ({
  isNativeMediaDescriptor: (value) => value?.__nativeMedia === true,
}));
vi.mock('../../services/gemini', () => ({ callGeminiApi: vi.fn() }));
vi.mock('../toastUtils', () => ({ showSuccessToast: vi.fn() }));

it('routes native segment processing through the clipping-aware core and restores absolute times', async () => {
  const media = Object.freeze({
    __nativeMedia: true,
    assetId: '01890f39-7b62-7c4e-8c9a-000000000101',
    name: 'source.mp4',
    type: 'video/mp4',
  });
  const segment = { start: 10, end: 20 };
  const onSubtitleUpdate = vi.fn();
  const completed = vi.fn();
  window.addEventListener('streaming-complete', completed);
  callGeminiApi.mockResolvedValue([
    { start: 1, end: 2, text: 'relative' },
    { start: 9, end: 10, text: 'clamped' },
  ]);

  const result = await processSegmentWithStreaming(
    media,
    segment,
    { model: 'gemini-3.5-flash-lite', mediaResolution: 'medium', runId: 'run-1' },
    vi.fn(),
    onSubtitleUpdate,
    (_key, fallback, values) => fallback.replace('{{count}}', String(values.count))
  );

  expect(callGeminiApi).toHaveBeenCalledWith(media, 'file-upload', {
    userProvidedSubtitles: undefined,
    modelId: 'gemini-3.5-flash-lite',
    mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
    segmentInfo: { start: 10, end: 20, duration: 10 },
    runId: 'run-1',
  });
  expect(result).toEqual([
    { start: 11, end: 12, text: 'relative' },
    { start: 19, end: 20, text: 'clamped' },
  ]);
  expect(onSubtitleUpdate).toHaveBeenCalledWith(result, false);
  expect(showSuccessToast).toHaveBeenCalledWith('Generated 2 subtitles', 5000);
  expect(completed).toHaveBeenCalledTimes(1);
  window.removeEventListener('streaming-complete', completed);
});

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
