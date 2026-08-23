import { publishStreamingComplete } from '../events/bus';
import { processAsrSegment } from '../services/engines/AsrAdapter';
import {
  checkpointBeforeUpdate,
} from '../services/lifecycleOrchestrator';
import { runAsrGeneration } from './runAsrGeneration';
import { acknowledgeJobResult } from '../platform/jobResultDeliveryService';

vi.mock('../events/bus', () => ({
  publishProcessingRanges: vi.fn(),
  publishStreamingUpdate: vi.fn(),
  publishStreamingComplete: vi.fn(),
}));

vi.mock('../services/engines/AsrAdapter', () => ({
  processAsrSegment: vi.fn(),
}));

vi.mock('../services/lifecycleOrchestrator', () => ({
  checkpointBeforeUpdate: vi.fn(),
}));

vi.mock('../platform/jobResultDeliveryService', () => ({
  acknowledgeJobResult: vi.fn(),
}));

vi.mock('../utils/subtitle/subtitleMerger', () => ({
  mergeSegmentSubtitles: (current, next) => [...current, ...next],
}));

const createParams = (overrides = {}) => ({
  engine: { id: 'parakeet', name: 'Parakeet' },
  input: { name: 'clip.wav' },
  options: { segment: { start: 10, end: 20 } },
  runId: 'run-1',
  debugLog: vi.fn(),
  setStatus: vi.fn(),
  setIsGenerating: vi.fn(),
  setSubtitlesData: vi.fn(),
  persistSubtitles: vi.fn(async () => undefined),
  t: vi.fn((key, fallback) => fallback || key),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  checkpointBeforeUpdate.mockResolvedValue(undefined);
  processAsrSegment.mockResolvedValue(true);
  acknowledgeJobResult.mockResolvedValue(undefined);
});

it('always clears generation state when native ASR fails', async () => {
  const failure = new Error('native ASR failed');
  processAsrSegment.mockRejectedValue(failure);
  const params = createParams();

  await expect(runAsrGeneration(params)).rejects.toBe(failure);

  expect(params.setIsGenerating).toHaveBeenCalledTimes(1);
  expect(params.setIsGenerating).toHaveBeenCalledWith(false);
  expect(publishStreamingComplete).not.toHaveBeenCalled();
});

it('also clears generation state when the pre-update checkpoint fails', async () => {
  const failure = new Error('checkpoint unavailable');
  checkpointBeforeUpdate.mockRejectedValue(failure);
  const params = createParams();

  await expect(runAsrGeneration(params)).rejects.toBe(failure);
  expect(processAsrSegment).not.toHaveBeenCalled();
  expect(checkpointBeforeUpdate).toHaveBeenCalledWith({
    source: 'segment-processing-start',
    segment: { start: 10, end: 20 },
    runId: 'run-1',
  });
  expect(params.setIsGenerating).toHaveBeenCalledTimes(1);
  expect(params.setIsGenerating).toHaveBeenCalledWith(false);
});

it('returns false for an invalid segment and clears generation state once', async () => {
  const params = createParams({ options: { segment: null } });

  await expect(runAsrGeneration(params)).resolves.toBe(false);
  expect(processAsrSegment).not.toHaveBeenCalled();
  expect(params.setStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  expect(params.setIsGenerating).toHaveBeenCalledTimes(1);
  expect(params.setIsGenerating).toHaveBeenCalledWith(false);
});

it('persists the complete merge before publishing completion', async () => {
  let subtitles = [{ start: 0, end: 1, text: 'existing' }];
  const setSubtitlesData = vi.fn((updater) => {
    if (typeof updater === 'function') subtitles = updater(subtitles);
    else subtitles = updater;
  });
  processAsrSegment.mockImplementation(async (engine, input, segment, options, hooks) => {
    await hooks.onMergeSegment(segment, [
      { start: 11, end: 12, text: 'inside' },
      { start: 19, end: 21, text: 'trimmed' },
    ]);
    hooks.onDeliveryReceipt({
      jobId: '018f22ea-6f3e-7cc0-a555-333333333333',
      deliveryId: '018f22ea-6f3e-7cc0-a555-444444444444',
    });
    return true;
  });
  const params = createParams({ setSubtitlesData });
  const owner = new AbortController();
  params.options.signal = owner.signal;

  await expect(runAsrGeneration(params)).resolves.toBe(true);

  expect(processAsrSegment).toHaveBeenCalledWith(
    params.engine,
    params.input,
    { start: 10, end: 20 },
    expect.objectContaining({ signal: owner.signal }),
    expect.any(Object),
  );

  expect(publishStreamingComplete).toHaveBeenCalledWith({
    subtitles: [
      { start: 11, end: 12, text: 'inside' },
      { start: 19, end: 20, text: 'trimmed' },
    ],
    segment: { start: 10, end: 20 },
    runId: 'run-1',
  });
  expect(params.persistSubtitles).toHaveBeenCalledExactlyOnceWith(subtitles);
  expect(params.persistSubtitles).toHaveBeenCalledBefore(publishStreamingComplete);
  expect(acknowledgeJobResult).toHaveBeenCalledExactlyOnceWith(
    '018f22ea-6f3e-7cc0-a555-333333333333',
    '018f22ea-6f3e-7cc0-a555-444444444444',
  );
  expect(params.persistSubtitles).toHaveBeenCalledBefore(acknowledgeJobResult);
  expect(params.setIsGenerating).toHaveBeenCalledTimes(1);
  expect(params.setIsGenerating).toHaveBeenCalledWith(false);
});

it('publishes neither success nor completion when the durable write fails', async () => {
  const failure = new Error('durable write failed');
  let subtitles = [{ start: 10, end: 11, text: 'visible but uncommitted' }];
  const params = createParams({
    setSubtitlesData: vi.fn((updater) => {
      if (typeof updater === 'function') subtitles = updater(subtitles);
      else subtitles = updater;
    }),
    persistSubtitles: vi.fn(async () => { throw failure; }),
  });

  await expect(runAsrGeneration(params)).rejects.toBe(failure);

  expect(publishStreamingComplete).not.toHaveBeenCalled();
  expect(params.setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  expect(params.setIsGenerating).toHaveBeenCalledWith(false);
});

it('keeps the native ASR delivery pending when the durable subtitle checkpoint fails', async () => {
  const failure = new Error('durable write failed');
  processAsrSegment.mockImplementation(async (engine, input, segment, options, hooks) => {
    hooks.onDeliveryReceipt({
      jobId: '018f22ea-6f3e-7cc0-a555-333333333333',
      deliveryId: '018f22ea-6f3e-7cc0-a555-444444444444',
    });
    return true;
  });
  let subtitles = [];
  const params = createParams({
    setSubtitlesData: vi.fn((updater) => {
      subtitles = typeof updater === 'function' ? updater(subtitles) : updater;
    }),
    persistSubtitles: vi.fn(async () => { throw failure; }),
  });

  await expect(runAsrGeneration(params)).rejects.toBe(failure);
  expect(acknowledgeJobResult).not.toHaveBeenCalled();
});
