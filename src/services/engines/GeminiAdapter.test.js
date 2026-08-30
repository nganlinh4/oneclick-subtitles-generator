import { processGeminiSegment } from './GeminiAdapter';
import { processSegmentWithStreaming } from '../../utils/videoProcessing/processingUtils';
import {
  bindNativeGeminiTranscriptionDelivery,
  getGeminiTranscriptionDeliveries,
} from '../gemini/transcriptionDelivery';

vi.mock('../../utils/videoProcessing/processingUtils', () => ({
  processSegmentWithStreaming: vi.fn(),
}));

const media = Object.freeze({
  assetId: '01890f39-7b62-7c4e-8c9a-000000000101',
  name: 'source.mp4',
  type: 'video/mp4',
});

beforeEach(() => {
  vi.clearAllMocks();
});

it('turns the advertised request maximum into independent native ranges and merges live rows', async () => {
  const acknowledgements = [];
  processSegmentWithStreaming.mockImplementation(async (
    _media, window, childOptions, _onStatus, onSubtitleUpdate
  ) => {
    const index = Math.round(window.start / 60);
    const row = { start: window.start + 1, end: window.start + 2, text: `part-${index + 1}` };
    onSubtitleUpdate([row], true);
    const acknowledge = vi.fn();
    acknowledgements.push(acknowledge);
    return bindNativeGeminiTranscriptionDelivery([row], {
      job: { id: `job-${index + 1}` },
      deliveryId: `delivery-${index + 1}`,
      acknowledge,
    });
  });
  const onStreamingUpdate = vi.fn();

  const result = await processGeminiSegment(
    media,
    { start: 0, end: 240 },
    { maxDurationPerRequest: 60, segmentProcessingDelay: 0 },
    { onStreamingUpdate, onStatus: vi.fn(), t: vi.fn() },
  );

  expect(processSegmentWithStreaming).toHaveBeenCalledTimes(4);
  expect(processSegmentWithStreaming.mock.calls.map((call) => call[1])).toEqual([
    expect.objectContaining({ start: 0, end: 60 }),
    expect.objectContaining({ start: 60, end: 120 }),
    expect.objectContaining({ start: 120, end: 180 }),
    expect.objectContaining({ start: 180, end: 240 }),
  ]);
  expect(processSegmentWithStreaming.mock.calls.every((call) => (
    call[2].maxDurationPerRequest === undefined
      && call[2].signal instanceof AbortSignal
  ))).toBe(true);
  expect(result.map(({ text }) => text)).toEqual(['part-1', 'part-2', 'part-3', 'part-4']);
  expect(getGeminiTranscriptionDeliveries(result).map(({ jobId }) => jobId)).toEqual([
    'job-1', 'job-2', 'job-3', 'job-4',
  ]);
  expect(acknowledgements.every((acknowledge) => acknowledge.mock.calls.length === 0)).toBe(true);
  expect(onStreamingUpdate).toHaveBeenCalledWith(
    expect.arrayContaining([
      expect.objectContaining({ text: 'part-1' }),
      expect.objectContaining({ text: 'part-4' }),
    ]),
    false,
    expect.objectContaining({ totalSegments: 4, segmentComplete: true }),
  );
});

it('keeps a range within the maximum on the single-job path', async () => {
  const rows = [{ start: 1, end: 2, text: 'one job' }];
  processSegmentWithStreaming.mockResolvedValue(rows);

  await expect(processGeminiSegment(
    media,
    { start: 0, end: 60 },
    { maxDurationPerRequest: 60 },
    {},
  )).resolves.toBe(rows);

  expect(processSegmentWithStreaming).toHaveBeenCalledTimes(1);
  expect(processSegmentWithStreaming.mock.calls[0][1]).toEqual({ start: 0, end: 60 });
  expect(processSegmentWithStreaming.mock.calls[0][2].maxDurationPerRequest).toBe(60);
});

it('bounds native clip and provider work for long videos', async () => {
  let active = 0;
  let peak = 0;
  const releases = [];
  processSegmentWithStreaming.mockImplementation(async (_media, window) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return [{ start: window.start, end: window.start + 1, text: String(window.index) }];
  });

  const pending = processGeminiSegment(
    media,
    { start: 0, end: 480 },
    { maxDurationPerRequest: 60, segmentProcessingDelay: 0 },
  );
  await vi.waitFor(() => expect(processSegmentWithStreaming).toHaveBeenCalledTimes(2));
  expect(peak).toBe(2);

  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(processSegmentWithStreaming).toHaveBeenCalledTimes(4));
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(processSegmentWithStreaming).toHaveBeenCalledTimes(6));
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(processSegmentWithStreaming).toHaveBeenCalledTimes(8));
  releases.splice(0).forEach((release) => release());
  await expect(pending).resolves.toHaveLength(8);
  expect(peak).toBe(2);
});

it('aborts active siblings and never starts queued windows after one part fails', async () => {
  const signals = [];
  processSegmentWithStreaming.mockImplementation((_media, window, childOptions) => {
    signals.push(childOptions.signal);
    if (window.index === 0) return Promise.reject(new Error('part failed'));
    return new Promise((_resolve, reject) => {
      childOptions.signal.addEventListener('abort', () => reject(childOptions.signal.reason), {
        once: true,
      });
    });
  });

  await expect(processGeminiSegment(
    media,
    { start: 0, end: 480 },
    { maxDurationPerRequest: 60, segmentProcessingDelay: 0 },
  )).rejects.toThrow('part failed');

  expect(processSegmentWithStreaming.mock.calls.length).toBeLessThanOrEqual(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
