import { startAsrJob } from '../../platform/asrService';
import {
  abortAllRequests,
  setProcessingForceStopped,
} from '../gemini/requestManagement';
import { processAsrSegment } from './AsrAdapter';

vi.mock('../../platform/asrService', () => ({
  startAsrJob: vi.fn(),
}));

const completedEvent = (overrides = {}) => ({
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
