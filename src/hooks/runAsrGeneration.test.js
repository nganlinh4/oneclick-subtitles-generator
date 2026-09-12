import { publishStreamingComplete } from '../events/bus';
import { processAsrSegment } from '../services/engines/AsrAdapter';
import {
  checkpointBeforeUpdate,
} from '../services/lifecycleOrchestrator';
import { runAsrGeneration } from './runAsrGeneration';
import { acknowledgeJobResult } from '../platform/jobResultDeliveryService';
import { ensureManagedEngineReady } from '../platform/managedEngineService';

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

vi.mock('../platform/managedEngineService', () => ({
  ensureManagedEngineReady: vi.fn(),
}));

vi.mock('../utils/subtitle/subtitleMerger', () => ({
  mergeSegmentSubtitles: (current, next, part) => [
    ...current.filter((row) => row.end <= part.start || row.start >= part.end),
    ...next,
  ],
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
  loadSubtitles: vi.fn(async () => []),
  captureGeneratedSegment: vi.fn(async () => undefined),
  persistGeneratedSegment: vi.fn(async () => undefined),
  t: vi.fn((key, fallback) => fallback || key),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  checkpointBeforeUpdate.mockResolvedValue(undefined);
  ensureManagedEngineReady.mockResolvedValue(undefined);
  processAsrSegment.mockResolvedValue(true);
  acknowledgeJobResult.mockResolvedValue(undefined);
});

it('prepares an uninstalled or cold engine from the feature action before invoking ASR', async () => {
  const params = createParams();

  await expect(runAsrGeneration(params)).resolves.toBe(true);

  expect(ensureManagedEngineReady).toHaveBeenCalledWith('parakeet', {
    signal: undefined,
    onProgress: expect.any(Function),
  });
  expect(ensureManagedEngineReady.mock.invocationCallOrder[0])
    .toBeLessThan(processAsrSegment.mock.invocationCallOrder[0]);
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
  expect(params.captureGeneratedSegment).not.toHaveBeenCalled();
  expect(checkpointBeforeUpdate).toHaveBeenCalledWith({
    source: 'generation-start',
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

it('loads the native track and persists the complete merge before publishing completion', async () => {
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
  const params = createParams({
    setSubtitlesData,
    loadSubtitles: vi.fn(async () => subtitles),
  });
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
  expect(checkpointBeforeUpdate).toHaveBeenCalledBefore(params.captureGeneratedSegment);
  expect(params.captureGeneratedSegment).toHaveBeenCalledBefore(params.loadSubtitles);
  expect(params.captureGeneratedSegment).toHaveBeenCalledBefore(processAsrSegment);

  expect(publishStreamingComplete).toHaveBeenCalledWith({
    subtitles: [
      { start: 11, end: 12, text: 'inside' },
      { start: 19, end: 20, text: 'trimmed' },
    ],
    segment: { start: 10, end: 20 },
    runId: 'run-1',
  });
  expect(params.persistGeneratedSegment).toHaveBeenCalledExactlyOnceWith([
    { start: 11, end: 12, text: 'inside' },
    { start: 19, end: 20, text: 'trimmed' },
  ]);
  expect(params.persistGeneratedSegment).toHaveBeenCalledBefore(publishStreamingComplete);
  expect(acknowledgeJobResult).toHaveBeenCalledExactlyOnceWith(
    '018f22ea-6f3e-7cc0-a555-333333333333',
    '018f22ea-6f3e-7cc0-a555-444444444444',
  );
  expect(params.persistGeneratedSegment).toHaveBeenCalledBefore(acknowledgeJobResult);
  expect(params.setIsGenerating).toHaveBeenCalledTimes(1);
  expect(params.setIsGenerating).toHaveBeenCalledWith(false);
});

it('never merges generated rows into a stale React track after all durable subtitles were deleted', async () => {
  let visible = [{ start: 0, end: 5, text: 'stale downloaded subtitle' }];
  const generated = [{ start: 10, end: 11, text: 'fresh generated subtitle' }];
  processAsrSegment.mockImplementation(async (_engine, _input, part, _options, hooks) => {
    await hooks.onMergeSegment(part, generated);
  });
  const params = createParams({
    loadSubtitles: vi.fn(async () => []),
    setSubtitlesData: vi.fn((rows) => { visible = rows; }),
  });

  await expect(runAsrGeneration(params)).resolves.toBe(true);

  expect(visible).toEqual(generated);
  expect(params.persistGeneratedSegment).toHaveBeenCalledExactlyOnceWith(generated);
});

it('publishes neither success nor completion when the durable write fails', async () => {
  const failure = new Error('durable write failed');
  let subtitles = [{ start: 10, end: 11, text: 'visible but uncommitted' }];
  const params = createParams({
    setSubtitlesData: vi.fn((updater) => {
      if (typeof updater === 'function') subtitles = updater(subtitles);
      else subtitles = updater;
    }),
    persistGeneratedSegment: vi.fn(async () => { throw failure; }),
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
    persistGeneratedSegment: vi.fn(async () => { throw failure; }),
  });

  await expect(runAsrGeneration(params)).rejects.toBe(failure);
  expect(acknowledgeJobResult).not.toHaveBeenCalled();
});

it('does not turn a committed aggregate into false failure when delivery acknowledgement is lost', async () => {
  const receipt = {
    jobId: '018f22ea-6f3e-7cc0-a555-333333333333',
    deliveryId: '018f22ea-6f3e-7cc0-a555-444444444444',
  };
  const generated = [{ start: 10, end: 11, text: 'durably committed' }];
  processAsrSegment.mockImplementation(async (_engine, _input, part, _options, hooks) => {
    await hooks.onMergeSegment(part, generated);
    hooks.onDeliveryReceipt(receipt);
  });
  acknowledgeJobResult.mockRejectedValueOnce(new Error('transport closed after native commit'));
  const params = createParams({
    persistGeneratedSegment: vi.fn(async () => ({ subtitles: generated })),
  });

  await expect(runAsrGeneration(params)).resolves.toBe(true);

  expect(params.persistGeneratedSegment).toHaveBeenCalledBefore(acknowledgeJobResult);
  expect(acknowledgeJobResult).toHaveBeenCalledExactlyOnceWith(
    receipt.jobId,
    receipt.deliveryId,
  );
  expect(publishStreamingComplete).toHaveBeenCalledTimes(1);
  expect(params.setStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

it('restores the current durable rows, not a deleted pre-run baseline, after a later window fails', async () => {
  const baseline = [{ start: 0, end: 2, text: 'baseline later deleted' }];
  const authoritativeAfterFailure = [];
  const failure = new Error('window three rejected malformed output');
  let visible = baseline;
  let loads = 0;
  processAsrSegment.mockImplementation(async (_engine, _input, part, _options, hooks) => {
    await hooks.onMergeSegment(part, [{ start: 10, end: 11, text: 'partial window one' }]);
    throw failure;
  });
  const params = createParams({
    loadSubtitles: vi.fn(async () => (loads++ === 0 ? baseline : authoritativeAfterFailure)),
    setSubtitlesData: vi.fn((rows) => { visible = rows; }),
  });

  await expect(runAsrGeneration(params)).rejects.toBe(failure);

  expect(visible).toEqual(authoritativeAfterFailure);
  expect(params.persistGeneratedSegment).not.toHaveBeenCalled();
  expect(publishStreamingComplete).not.toHaveBeenCalled();
  expect(acknowledgeJobResult).not.toHaveBeenCalled();
});

it('publishes the authoritative CAS result so concurrent rows outside the generated range survive', async () => {
  const replacement = [{ start: 10, end: 11, text: 'generated' }];
  const authoritative = [
    { start: 0, end: 1, text: 'concurrent outside edit' },
    ...replacement,
  ];
  let visible = [];
  processAsrSegment.mockImplementation(async (_engine, _input, part, _options, hooks) => {
    await hooks.onMergeSegment(part, replacement);
  });
  const params = createParams({
    setSubtitlesData: vi.fn((rows) => { visible = rows; }),
    persistGeneratedSegment: vi.fn(async () => ({ subtitles: authoritative })),
  });

  await expect(runAsrGeneration(params)).resolves.toBe(true);

  expect(params.persistGeneratedSegment).toHaveBeenCalledWith(replacement);
  expect(visible).toEqual(authoritative);
});

it('commits an empty aggregate as an intentional replacement instead of retaining stale cues', async () => {
  const baseline = [{ start: 10, end: 11, text: 'old cue in silent range' }];
  processAsrSegment.mockImplementation(async (_engine, _input, part, _options, hooks) => {
    await hooks.onMergeSegment(part, []);
  });
  const params = createParams({
    loadSubtitles: vi.fn(async () => baseline),
    persistGeneratedSegment: vi.fn(async () => ({ subtitles: [] })),
  });

  await expect(runAsrGeneration(params)).resolves.toBe(true);

  expect(params.persistGeneratedSegment).toHaveBeenCalledExactlyOnceWith([]);
  expect(params.setSubtitlesData).toHaveBeenLastCalledWith([]);
});
