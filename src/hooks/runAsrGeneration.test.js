import { publishStreamingComplete } from '../events/bus';
import { processAsrSegment } from '../services/engines/AsrAdapter';
import {
  autoSaveAfterStreaming,
  checkpointBeforeUpdate,
} from '../services/lifecycleOrchestrator';
import { runAsrGeneration } from './runAsrGeneration';

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
  autoSaveAfterStreaming: vi.fn(),
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
  t: vi.fn((key, fallback) => fallback || key),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  checkpointBeforeUpdate.mockResolvedValue(undefined);
  processAsrSegment.mockResolvedValue(true);
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

it('preserves successful merge, completion, and auto-save behavior', async () => {
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
    return true;
  });
  const params = createParams({ setSubtitlesData });

  await expect(runAsrGeneration(params)).resolves.toBe(true);

  expect(publishStreamingComplete).toHaveBeenCalledWith({
    subtitles: [
      { start: 11, end: 12, text: 'inside' },
      { start: 19, end: 20, text: 'trimmed' },
    ],
    segment: { start: 10, end: 20 },
    runId: 'run-1',
  });
  expect(autoSaveAfterStreaming).toHaveBeenCalledWith({
    subtitles,
    segment: { start: 10, end: 20 },
    delayMs: 500,
  });
  expect(params.setIsGenerating).toHaveBeenCalledTimes(1);
  expect(params.setIsGenerating).toHaveBeenCalledWith(false);
});
