import fs from 'fs';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import {
  ASR_ENGINE_CATALOG,
  ASR_ENGINE_IDS,
  AsrServiceError,
  createNativeAsrService,
  normalizeAsrJobEvent,
  normalizeAsrStartRequest,
  normalizeAsrStatus,
} from './asrService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

class TestChannel {
  onmessage = () => {};

  emit(value) {
    this.onmessage(value);
  }
}

const jobSnapshot = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'transcribe',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

const transcription = (overrides = {}) => ({
  engine: 'parakeet',
  text: 'hello world',
  segments: [{ startMs: 0, endMs: 1_250, text: 'hello world' }],
  durationMs: 1_250,
  language: null,
  backend: 'direct_ml',
  ...overrides,
});

const completedEvent = (id, overrides = {}) => ({
  event: 'completed',
  job: jobSnapshot({
    id,
    state: 'succeeded',
    progress: { basisPoints: 10_000 },
    sequence: 2,
  }),
  transcription: transcription(),
  timelineOffsetMs: 0,
  ...overrides,
});

const statusPayload = () => ({
  workerAvailable: true,
  engines: ASR_ENGINE_CATALOG.map((engine, index) => ({
    ...engine,
    label: `Engine ${index + 1}`,
    installed: index < 2,
    ready: index < 2,
    warm: index === 0,
  })),
});

const createService = (overrides = {}) => createNativeAsrService({
  invokeCommand: vi.fn(),
  ChannelConstructor: TestChannel,
  isNativeRuntime: () => true,
  ...overrides,
});

it('contains no HTTP, browser storage, provider secret, or raw-file transport', () => {
  const source = fs.readFileSync(path.join(__dirname, 'asrService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/https?:\/\//i);
  expect(source).not.toMatch(/\bapiKey\b/);
  expect(source).not.toMatch(/\b(file|path|bytes|base64)\s*:/i);
});

it('normalizes legacy aliases, defaults, segmentation bounds, and seconds to Rust wire values', () => {
  expect(normalizeAsrStartRequest({
    engine: 'nvidia-parakeet',
    strategy: 'char',
    maxCharacters: 5,
    maxWords: -1,
    pauseThresholdMs: 100,
    range: { start: 1.0004, end: 2.0006 },
  })).toEqual({
    engine: 'parakeet',
    strategy: 'character',
    maxCharacters: 5,
    maxWords: null,
    pauseThresholdMs: 100,
    range: { startMs: 1_000, endMs: 2_001 },
  });

  expect(normalizeAsrStartRequest({ engine: 'faster-whisper-turbo' })).toEqual({
    engine: 'faster-whisper-turbo',
    strategy: 'sentence',
    maxCharacters: 60,
    maxWords: 7,
    pauseThresholdMs: 800,
  });

  expect(normalizeAsrStartRequest({
    engine: 'faster-whisper-large-v3',
    language: ' EN ',
    range: { startSeconds: 0, endSeconds: 86_400 },
  })).toEqual(expect.objectContaining({
    language: 'en',
    range: { startMs: 0, endMs: 86_400_000 },
  }));
});

it('rejects unknown engines/options, invalid languages, unsafe ranges, and out-of-bound settings', () => {
  const invalidRequests = [
    { engine: 'whisper' },
    { engine: 'parakeet', unknown: true },
    { engine: 'parakeet', language: 'en' },
    { engine: 'faster-whisper-turbo', language: 'auto' },
    { engine: 'qwen3-asr-1.7b', language: 'vi' },
    { engine: 'faster-whisper-turbo', maxCharacters: 4 },
    { engine: 'faster-whisper-turbo', maxWords: 0 },
    { engine: 'faster-whisper-turbo', pauseThresholdMs: 99 },
    { engine: 'faster-whisper-turbo', range: { start: 1, end: 1 } },
    { engine: 'faster-whisper-turbo', range: { start: 0, end: 86_400.001 } },
    { engine: 'faster-whisper-turbo', range: { startMs: 0, endMs: 1_000 } },
  ];
  invalidRequests.forEach((request) => {
    expect(() => normalizeAsrStartRequest(request)).toThrow(AsrServiceError);
  });
});

it('strictly validates and canonically orders the five-engine status catalog', () => {
  const raw = statusPayload();
  raw.engines.reverse();
  raw.privatePath = 'must not be copied';
  const status = normalizeAsrStatus(raw);

  expect(status.engines.map(({ id }) => id)).toEqual(ASR_ENGINE_IDS);
  expect(status).not.toHaveProperty('privatePath');
  expect(status.engines[0]).toEqual(expect.objectContaining({
    id: 'parakeet',
    runtime: 'onnx',
    supportsForcedLanguage: false,
    requiresAligner: false,
  }));

  const missing = statusPayload();
  missing.engines.pop();
  expect(() => normalizeAsrStatus(missing)).toThrow(AsrServiceError);
  const capabilityLie = statusPayload();
  capabilityLie.engines[0].supportsForcedLanguage = true;
  expect(() => normalizeAsrStatus(capabilityLie)).toThrow(AsrServiceError);
  const impossibleState = statusPayload();
  impossibleState.engines[4].warm = true;
  expect(() => normalizeAsrStatus(impossibleState)).toThrow(AsrServiceError);
  const unavailableWorker = statusPayload();
  unavailableWorker.workerAvailable = false;
  expect(() => normalizeAsrStatus(unavailableWorker)).toThrow(AsrServiceError);
});

it('invokes exact native status/start command shapes and dispatches typed events', async () => {
  const initial = jobSnapshot();
  let channel;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'asr_status') return statusPayload();
    channel = args.onEvent;
    return initial;
  });
  const onProgress = vi.fn();
  const onCompleted = vi.fn();
  const service = createService({ invokeCommand });

  await expect(service.getAsrStatus()).resolves.toEqual(normalizeAsrStatus(statusPayload()));
  expect(invokeCommand).toHaveBeenCalledWith('asr_status', {});
  await expect(service.startAsrJob({ engine: 'nvidia-parakeet' }, {
    onProgress,
    onCompleted,
  })).resolves.toEqual(initial);
  expect(invokeCommand.mock.calls[1][0]).toBe('asr_start');
  expect(invokeCommand.mock.calls[1][1].request).toEqual(expect.objectContaining({
    engine: 'parakeet',
    strategy: 'sentence',
  }));
  expect(invokeCommand.mock.calls[1][1]).toEqual({
    request: expect.any(Object),
    onEvent: expect.any(TestChannel),
  });

  channel.emit({
    event: 'progress',
    jobId: initial.id,
    phase: 'preparingAudio',
    fraction: 0.25,
  });
  channel.emit(completedEvent(initial.id));

  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ fraction: 0.25 }));
  expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
    transcription: expect.objectContaining({ text: 'hello world' }),
  }));
});

it('preserves early Channel events until the initial UUIDv7 snapshot is registered', async () => {
  const initial = jobSnapshot();
  let resolveStart;
  const onProgress = vi.fn();
  const invokeCommand = vi.fn((command, args) => {
    args.onEvent.emit({
      event: 'progress',
      jobId: initial.id,
      phase: 'modelLoading',
      fraction: null,
    });
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  const service = createService({ invokeCommand });

  const started = service.startAsrJob({ engine: 'parakeet' }, { onProgress });
  expect(onProgress).not.toHaveBeenCalled();
  resolveStart(initial);
  await started;
  expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'modelLoading' }));
});

it('normalizes completed, cancelled, and failed events without copying diagnostics', () => {
  const id = uuidv7();
  const completed = normalizeAsrJobEvent(completedEvent(id, {
    privatePath: 'hidden',
    transcription: { ...transcription(), workerDiagnostics: 'hidden' },
  }));
  expect(completed).not.toHaveProperty('privatePath');
  expect(completed.transcription).not.toHaveProperty('workerDiagnostics');

  expect(normalizeAsrJobEvent({
    event: 'cancelled',
    job: jobSnapshot({ id, state: 'cancelled', sequence: 2 }),
  })).toEqual(expect.objectContaining({ event: 'cancelled' }));

  const failed = normalizeAsrJobEvent({
    event: 'failed',
    job: null,
    error: { code: 'asrWorker', message: 'Worker stopped', traceback: 'hidden' },
    rawPayload: 'hidden',
  });
  expect(failed).toEqual({
    event: 'failed',
    job: null,
    error: { code: 'asrWorker', message: 'Worker stopped' },
  });
});

it('rejects malformed progress, snapshots, transcription timing, and oversized result data', () => {
  const id = uuidv7();
  expect(() => normalizeAsrJobEvent({
    event: 'progress', jobId: id, phase: 'downloading', fraction: 0.5,
  })).toThrow(AsrServiceError);
  expect(() => normalizeAsrJobEvent({
    event: 'progress', jobId: id, phase: 'transcribing', fraction: 1.01,
  })).toThrow(AsrServiceError);
  expect(() => normalizeAsrJobEvent(completedEvent(id, {
    job: jobSnapshot({ id, state: 'succeeded', progress: { basisPoints: 9_999 }, sequence: 2 }),
  }))).toThrow(AsrServiceError);
  expect(() => normalizeAsrJobEvent(completedEvent(id, {
    transcription: transcription({
      segments: [{ startMs: 1_000, endMs: 2_000, text: 'outside' }],
    }),
  }))).toThrow(AsrServiceError);
  expect(() => normalizeAsrJobEvent(completedEvent(id, {
    transcription: transcription({
      segments: [{ startMs: 500, endMs: 500, text: 'empty timing' }],
    }),
  }))).toThrow(AsrServiceError);
  expect(() => normalizeAsrJobEvent(completedEvent(id, {
    transcription: transcription({ text: 'a'.repeat((8 * 1024 * 1024) + 1) }),
  }))).toThrow(AsrServiceError);
});

it('fails closed on a Channel protocol violation and cancels the native job once', async () => {
  const initial = jobSnapshot();
  let channel;
  const onProtocolError = vi.fn();
  const onCompleted = vi.fn();
  const cancelling = jobSnapshot({ id: initial.id, state: 'cancelling', sequence: 2 });
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'asr_start') {
      channel = args.onEvent;
      return initial;
    }
    expect(command).toBe('job_cancel');
    expect(args).toEqual({ id: initial.id });
    return cancelling;
  });
  const service = createService({
    invokeCommand,
  });
  await service.startAsrJob({
    engine: 'parakeet',
    range: { start: 10, end: 12 },
  }, { onProtocolError, onCompleted });

  channel.emit({
    event: 'progress', jobId: uuidv7(), phase: 'preparingAudio', fraction: null,
  });
  channel.emit({
    event: 'progress', jobId: initial.id, phase: 'transcribing', fraction: null,
  });
  channel.emit(completedEvent(initial.id, { timelineOffsetMs: 10_000 }));
  await Promise.resolve();

  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(onCompleted).not.toHaveBeenCalled();
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel'))
    .toHaveLength(1);
});

it('cancels a registered job when a malformed event arrives before start resolves', async () => {
  const initial = jobSnapshot();
  const cancelling = jobSnapshot({ id: initial.id, state: 'cancelling', sequence: 2 });
  const onProtocolError = vi.fn();
  let resolveStart;
  const invokeCommand = vi.fn((command, args) => {
    if (command === 'asr_start') {
      args.onEvent.emit({ event: 'progress', jobId: initial.id, phase: 'unknown' });
      return new Promise((resolve) => { resolveStart = resolve; });
    }
    expect(args).toEqual({ id: initial.id });
    return Promise.resolve(cancelling);
  });
  const service = createService({ invokeCommand });

  const started = service.startAsrJob(
    { engine: 'parakeet' },
    { onProtocolError }
  );
  resolveStart(initial);
  await expect(started).rejects.toMatchObject({ code: 'invalidAsrResponse' });
  await Promise.resolve();

  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel'))
    .toHaveLength(1);
});

it('isolates synchronous and asynchronous handler failures', async () => {
  const initial = jobSnapshot();
  let channel;
  const onHandlerError = vi.fn();
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      channel = args.onEvent;
      return initial;
    }),
  });
  await service.startAsrJob({ engine: 'parakeet' }, {
    onEvent: () => { throw new Error('sync failure'); },
    onProgress: () => Promise.reject(new Error('async failure')),
    onHandlerError,
  });
  channel.emit({
    event: 'progress', jobId: initial.id, phase: 'preparingAudio', fraction: null,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(onHandlerError).toHaveBeenCalledTimes(2);
});

it('defers AbortSignal cancellation until the start snapshot registers the job ID', async () => {
  const initial = jobSnapshot();
  const cancelling = jobSnapshot({ id: initial.id, state: 'cancelling', sequence: 2 });
  const controller = new AbortController();
  let resolveStart;
  const calls = [];
  const invokeCommand = vi.fn((command, args) => {
    calls.push(command);
    if (command === 'asr_start') {
      return new Promise((resolve) => { resolveStart = resolve; });
    }
    expect(args).toEqual({ id: initial.id });
    return Promise.resolve(cancelling);
  });
  const service = createService({ invokeCommand });

  const started = service.startAsrJob(
    { engine: 'parakeet' },
    undefined,
    { signal: controller.signal }
  );
  controller.abort();
  expect(calls).toEqual(['asr_start']);
  resolveStart(initial);
  await expect(started).resolves.toEqual(initial);
  await Promise.resolve();
  expect(calls).toEqual(['asr_start', 'job_cancel']);
});

it('rejects an already-aborted signal without creating a native job', async () => {
  const controller = new AbortController();
  controller.abort();
  const invokeCommand = vi.fn();
  const service = createService({ invokeCommand });

  await expect(service.startAsrJob(
    { engine: 'parakeet' },
    undefined,
    { signal: controller.signal }
  )).rejects.toMatchObject({ code: 'asrCancelled' });
  expect(invokeCommand).not.toHaveBeenCalled();
});

it('reports AbortSignal cancellation errors safely and cancels at most once', async () => {
  const initial = jobSnapshot();
  const controller = new AbortController();
  const onCancellationError = vi.fn();
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'asr_start') return initial;
    throw new Error('cancel unavailable');
  });
  const service = createService({ invokeCommand });
  await service.startAsrJob(
    { engine: 'parakeet' },
    { onCancellationError },
    { signal: controller.signal }
  );
  controller.abort();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toHaveLength(1);
  expect(onCancellationError).toHaveBeenCalledWith(expect.any(Error));
});

it('validates explicit job cancellation and rejects mismatched native snapshots', async () => {
  const id = uuidv7();
  const cancelling = jobSnapshot({ id, state: 'cancelling', sequence: 2 });
  const invokeCommand = vi.fn().mockResolvedValue(cancelling);
  const service = createService({ invokeCommand });
  await expect(service.cancelAsrJob(id)).resolves.toEqual(cancelling);
  expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id });
  await expect(service.cancelAsrJob('not-v7'))
    .rejects.toMatchObject({ code: 'invalidAsrRequest' });

  invokeCommand.mockResolvedValue(jobSnapshot({ state: 'cancelling', sequence: 2 }));
  await expect(service.cancelAsrJob(id))
    .rejects.toMatchObject({ code: 'invalidAsrResponse' });
});

it('fails closed outside Tauri without invoking any command', async () => {
  const invokeCommand = vi.fn();
  const service = createNativeAsrService({
    invokeCommand,
    ChannelConstructor: TestChannel,
    isNativeRuntime: () => false,
  });
  await expect(service.getAsrStatus()).rejects.toMatchObject({ code: 'desktopAsrRequired' });
  await expect(service.startAsrJob({ engine: 'parakeet' }))
    .rejects.toMatchObject({ code: 'desktopAsrRequired' });
  await expect(service.cancelAsrJob(uuidv7()))
    .rejects.toMatchObject({ code: 'desktopAsrRequired' });
  expect(invokeCommand).not.toHaveBeenCalled();
});
