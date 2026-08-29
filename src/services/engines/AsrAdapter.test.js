import { startAsrJob } from '../../platform/asrService';
import { ensureNativeJobRecoveryReady } from '../../platform/jobRecoveryCoordinator';
import {
  abortAllRequests,
  setProcessingForceStopped,
} from '../gemini/requestManagement';
import { processAsrSegment } from './AsrAdapter';

vi.mock('../../platform/asrService', () => ({
  startAsrJob: vi.fn(),
}));
vi.mock('../../platform/jobRecoveryCoordinator', () => ({
  ensureNativeJobRecoveryReady: vi.fn().mockResolvedValue({ unavailable: false }),
}));

const completedEvent = (overrides = {}) => ({
  job: { id: '018f22ea-6f3e-7cc0-a555-333333333333' },
  deliveryId: '018f22ea-6f3e-7cc0-a555-444444444444',
  timelineOffsetMs: 12_000,
  transcription: {
    segments: [{ startMs: 250, endMs: 1_250, text: 'native result' }],
  },
  ...overrides,
});

afterEach(() => {
  setProcessingForceStopped(false);
  vi.clearAllMocks();
  delete global.fetch;
});

it('uses path-free native ASR and maps millisecond results onto the global timeline', async () => {
  startAsrJob.mockImplementation((request, handlers) => {
    handlers.onCompleted(completedEvent());
    return Promise.resolve({ id: 'registered' });
  });
  const onStreamingUpdate = vi.fn();
  const onMergeSegment = vi.fn();
  const onRanges = vi.fn();

  await expect(processAsrSegment(
    { id: 'faster-whisper-turbo', name: 'Whisper Turbo' },
    { name: 'must-not-be-read.mp4' },
    { start: 12, end: 14 },
    {
      maxDurationPerRequest: 10,
      asrStrategy: 'word',
      asrMaxChars: 80,
      asrMaxWords: -1,
      asrLanguage: 'EN',
    },
    { onStreamingUpdate, onMergeSegment, onRanges }
  )).resolves.toBe(true);

  expect(startAsrJob).toHaveBeenCalledWith({
    engine: 'faster-whisper-turbo',
    strategy: 'word',
    maxCharacters: 80,
    maxWords: -1,
    pauseThresholdMs: 800,
    language: 'EN',
    range: { start: 12, end: 14 },
  }, expect.any(Object), { signal: expect.any(AbortSignal) });
  const expected = [{ start: 12.25, end: 13.25, text: 'native result' }];
  expect(onStreamingUpdate).toHaveBeenCalledWith(expected, { start: 12, end: 14 });
  expect(onMergeSegment).toHaveBeenCalledWith({ start: 12, end: 14 }, expected);
  expect(onRanges).toHaveBeenLastCalledWith([]);
  expect(abortAllRequests()).toBe(false);
});

it('does not create an ASR job until durable recovery is trustworthy', async () => {
  const unavailable = Object.assign(new Error('recovery unavailable'), {
    code: 'nativeJobRecoveryUnavailable',
    retryable: true,
  });
  ensureNativeJobRecoveryReady.mockRejectedValueOnce(unavailable);

  await expect(processAsrSegment(
    'parakeet',
    null,
    { start: 0, end: 1 },
    {},
    {},
  )).rejects.toBe(unavailable);
  expect(startAsrJob).not.toHaveBeenCalled();
});

it('global cancellation rejects immediately while forwarding the AbortSignal to native cleanup', async () => {
  let nativeSignal;
  startAsrJob.mockImplementation((request, handlers, options) => {
    nativeSignal = options.signal;
    return Promise.resolve({ id: 'registration-pending-terminal-event' });
  });
  const onRanges = vi.fn();

  const pending = processAsrSegment(
    'parakeet',
    null,
    { start: 0, end: 0.5 },
    {},
    { onRanges }
  );
  await Promise.resolve();
  const cancelled = pending.catch((error) => error);
  expect(startAsrJob).toHaveBeenCalledTimes(1);
  expect(abortAllRequests()).toBe(true);

  await expect(cancelled).resolves.toMatchObject({
    name: 'AbortError',
    code: 'asrCancelled',
  });
  expect(nativeSignal.aborted).toBe(true);
  expect(onRanges).toHaveBeenLastCalledWith([]);
  expect(abortAllRequests()).toBe(false);
});

it('an owning run can cancel ASR without aborting unrelated global requests', async () => {
  const owner = new AbortController();
  let nativeSignal;
  startAsrJob.mockImplementation((_request, _handlers, options) => {
    nativeSignal = options.signal;
    return Promise.resolve({ id: 'owned-registration' });
  });

  const pending = processAsrSegment(
    'parakeet',
    null,
    { start: 0, end: 1 },
    { signal: owner.signal },
    {}
  );
  await Promise.resolve();
  const cancelled = pending.catch((error) => error);
  owner.abort();

  await expect(cancelled).resolves.toMatchObject({
    name: 'AbortError',
    code: 'asrCancelled',
  });
  expect(nativeSignal.aborted).toBe(true);
  expect(abortAllRequests()).toBe(false);
});

it('global cancellation during window preparation prevents native job creation', async () => {
  startAsrJob.mockResolvedValue({ id: 'must-not-start' });

  const pending = processAsrSegment(
    'parakeet',
    null,
    { start: 0, end: 5 },
    {},
    {}
  );
  const cancelled = pending.catch((error) => error);
  expect(abortAllRequests()).toBe(true);

  await expect(cancelled).resolves.toMatchObject({
    name: 'AbortError',
    code: 'asrCancelled',
  });
  expect(startAsrJob).not.toHaveBeenCalled();
  expect(abortAllRequests()).toBe(false);
});

it('fails closed outside the desktop boundary without encoding media or contacting HTTP', async () => {
  const unavailable = Object.assign(
    new Error('This operation requires the desktop runtime'),
    { code: 'desktopRuntimeRequired' }
  );
  startAsrJob.mockRejectedValue(unavailable);
  global.fetch = vi.fn();

  await expect(processAsrSegment(
    { id: 'qwen3-asr-0.6b', route: 'asr/qwen3-asr-0.6b' },
    { name: 'clip.wav' },
    { start: 20, end: 22 },
    { asrLanguage: 'auto', maxDurationPerRequest: 10 }
  )).rejects.toBe(unavailable);

  expect(startAsrJob).toHaveBeenCalledWith(
    expect.objectContaining({ engine: 'qwen3-asr-0.6b', range: { start: 20, end: 22 } }),
    expect.any(Object),
    { signal: expect.any(AbortSignal) }
  );
  expect(global.fetch).not.toHaveBeenCalled();
  expect(abortAllRequests()).toBe(false);
});

it('releases controller and range state when native protocol validation fails', async () => {
  const protocolError = Object.assign(new Error('invalid native event'), {
    code: 'invalidAsrResponse',
  });
  startAsrJob.mockImplementation((request, handlers) => {
    handlers.onProtocolError(protocolError);
    return Promise.resolve({ id: 'quarantined' });
  });
  const onRanges = vi.fn();

  await expect(processAsrSegment(
    'parakeet',
    null,
    { start: 0, end: 1 },
    {},
    { onRanges }
  )).rejects.toBe(protocolError);
  expect(onRanges).toHaveBeenLastCalledWith([]);
  expect(abortAllRequests()).toBe(false);
});

it('merges four windows sequentially and publishes each receipt only after its merge completes', async () => {
  const order = [];
  let call = 0;
  startAsrJob.mockImplementation((request, handlers) => {
    const index = call++;
    order.push(`start:${index}:${request.range.start}`);
    handlers.onCompleted(completedEvent({
      job: { id: `job-${index}` },
      deliveryId: `delivery-${index}`,
      timelineOffsetMs: Math.round(request.range.start * 1_000),
      transcription: {
        segments: [{ startMs: 0, endMs: 500, text: `window ${index}` }],
      },
    }));
    return Promise.resolve({ id: `registered-${index}` });
  });
  const onMergeSegment = vi.fn(async (part, rows) => {
    order.push(`merge:${rows[0].text}:${part.start}`);
  });
  const onDeliveryReceipt = vi.fn(async ({ jobId }) => {
    order.push(`receipt:${jobId}`);
  });

  await processAsrSegment(
    'parakeet',
    null,
    { start: 0, end: 4 },
    { maxDurationPerRequest: 1 },
    { onMergeSegment, onDeliveryReceipt },
  );

  expect(startAsrJob).toHaveBeenCalledTimes(4);
  expect(onMergeSegment).toHaveBeenCalledTimes(4);
  expect(onDeliveryReceipt).toHaveBeenCalledTimes(4);
  expect(order).toEqual([
    'start:0:0', 'merge:window 0:0', 'receipt:job-0',
    'start:1:1', 'merge:window 1:1', 'receipt:job-1',
    'start:2:2', 'merge:window 2:2', 'receipt:job-2',
    'start:3:3', 'merge:window 3:3', 'receipt:job-3',
  ]);
});

it('stops after a rejected window and ignores a contradictory late completion', async () => {
  const failure = { code: 'asrWorker', message: 'window two failed' };
  let call = 0;
  startAsrJob.mockImplementation((request, handlers) => {
    const index = call++;
    if (index === 0) {
      handlers.onCompleted(completedEvent({
        timelineOffsetMs: Math.round(request.range.start * 1_000),
      }));
    } else {
      handlers.onFailed({ error: failure });
      handlers.onCompleted(completedEvent({
        timelineOffsetMs: Math.round(request.range.start * 1_000),
      }));
    }
    return Promise.resolve({ id: `registered-${index}` });
  });
  const onMergeSegment = vi.fn();
  const onDeliveryReceipt = vi.fn();

  await expect(processAsrSegment(
    'parakeet',
    null,
    { start: 0, end: 4 },
    { maxDurationPerRequest: 1 },
    { onMergeSegment, onDeliveryReceipt },
  )).rejects.toMatchObject({ code: 'asrWorker', message: 'window two failed' });

  expect(startAsrJob).toHaveBeenCalledTimes(2);
  expect(onMergeSegment).toHaveBeenCalledTimes(1);
  expect(onDeliveryReceipt).toHaveBeenCalledTimes(1);
});
