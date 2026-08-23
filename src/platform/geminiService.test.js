import fs from 'fs';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import {
  GeminiServiceError,
  createNativeGeminiService,
  normalizeGeminiJobEvent,
  normalizeGeminiStartRequest,
  normalizeJobSnapshot,
} from './geminiService';

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

const nativeRequest = (overrides = {}) => ({
  credentialId: uuidv7(),
  task: 'transcribe',
  model: 'gemini-3.5-flash-lite',
  prompt: 'Transcribe the selected media.',
  mediaAssetId: uuidv7(),
  ...overrides,
});

it('contains no direct provider transport or browser credential-storage path', () => {
  const source = fs.readFileSync(path.join(__dirname, 'geminiService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/generativelanguage\.googleapis\.com/i);
  expect(source).not.toMatch(/\bapiKey\b/);
});

it('normalizes the native request to exact Rust enum values', () => {
  const projectId = uuidv7();
  const request = normalizeGeminiStartRequest(nativeRequest({
    thinkingLevel: 'minimal',
    mediaResolution: 'medium',
    emptySpeechPolicy: 'provenSilence',
    maxOutputTokens: 8192,
    responseJsonSchema: {
      type: 'array',
      items: { type: 'object' },
    },
    projectId,
    expectedProjectStateVersion: 7,
  }));

  expect(request).toEqual(expect.objectContaining({
    thinkingLevel: 'MINIMAL',
    mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
    emptySpeechPolicy: 'provenSilence',
    maxOutputTokens: 8192,
    projectId,
    expectedProjectStateVersion: 7,
  }));
});

it('requires project ownership as one exact UUID/version pair', () => {
  const projectId = uuidv7();
  expect(normalizeGeminiStartRequest(nativeRequest({
    projectId,
    expectedProjectStateVersion: 0,
  }))).toMatchObject({ projectId, expectedProjectStateVersion: 0 });

  for (const authority of [
    { projectId },
    { expectedProjectStateVersion: 0 },
    { projectId: 'not-a-project', expectedProjectStateVersion: 0 },
    { projectId, expectedProjectStateVersion: -1 },
    { projectId, expectedProjectStateVersion: 1.5 },
    { projectId, expectedProjectStateVersion: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(() => normalizeGeminiStartRequest(nativeRequest(authority)))
      .toThrow(GeminiServiceError);
  }

  const generic = normalizeGeminiStartRequest(nativeRequest({
    task: 'translate',
    mediaAssetId: null,
  }));
  expect(generic).not.toHaveProperty('projectId');
  expect(generic).not.toHaveProperty('expectedProjectStateVersion');
});

it('only accepts the proven-silence policy for media transcription', () => {
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    emptySpeechPolicy: 'assumeSilence',
  }))).toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    task: 'translate',
    emptySpeechPolicy: 'provenSilence',
  }))).toThrow(GeminiServiceError);
});

it('allows catalog models for media and validated custom models only for text', () => {
  const catalogMedia = normalizeGeminiStartRequest(nativeRequest({
    model: 'gemini-3.7-flash',
  }));
  expect(catalogMedia.model).toBe('gemini-3.7-flash');

  const customText = normalizeGeminiStartRequest(nativeRequest({
    task: 'translate',
    model: 'gemini-3.8-flash',
    mediaAssetId: null,
    prompt: 'Translate this text.',
    maxOutputTokens: 65_536,
  }));
  expect(customText.model).toBe('gemini-3.8-flash');

  expect(() => normalizeGeminiStartRequest(nativeRequest({
    model: 'gemini-3.8-flash',
  }))).toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    task: 'translate',
    model: 'gemini-3.8-flash',
    mediaAssetId: uuidv7(),
  }))).toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    task: 'analyzeSubtitles',
    model: 'gemini-3.8-flash',
    mediaAssetId: null,
    mediaResolution: 'medium',
  }))).toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    task: 'translate',
    model: 'gemini-3.8-flash',
    mediaAssetId: null,
    thinkingLevel: 'low',
  }))).toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    model: 'gemini-2.5-flash-image',
  }))).toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    model: 'models/gemini-3.5-flash-lite',
  }))).toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    apiKey: 'must-never-be-accepted',
  }))).toThrow(GeminiServiceError);
});

it('enforces the selected model thinking-level contract before native invocation', () => {
  expect(normalizeGeminiStartRequest(nativeRequest({
    model: 'gemini-3.7-flash',
    thinkingLevel: 'low',
  })).thinkingLevel).toBe('LOW');
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    model: 'gemini-3.7-flash',
    thinkingLevel: 'minimal',
  }))).toThrow(GeminiServiceError);
  expect(normalizeGeminiStartRequest(nativeRequest({
    model: 'gemini-3.6-flash',
    thinkingLevel: 'minimal',
  })).thinkingLevel).toBe('MINIMAL');
});

it('bounds prompt, output, and schema inputs before invoking native code', () => {
  expect(() => normalizeGeminiStartRequest(nativeRequest({ prompt: '   ' })))
    .toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({ maxOutputTokens: 65_537 })))
    .toThrow(GeminiServiceError);
  expect(() => normalizeGeminiStartRequest(nativeRequest({
    responseJsonSchema: { description: '한'.repeat(400_000) },
  }))).toThrow(GeminiServiceError);
  const cyclic = {};
  cyclic.self = cyclic;
  expect(() => normalizeGeminiStartRequest(nativeRequest({ responseJsonSchema: cyclic })))
    .toThrow(GeminiServiceError);
});

it('passes the exact Tauri command arguments and dispatches typed Channel events', async () => {
  const initial = jobSnapshot();
  const projectId = uuidv7();
  let channel;
  const invokeCommand = vi.fn(async (command, args) => {
    expect(command).toBe('gemini_start');
    channel = args.onEvent;
    return initial;
  });
  const onEvent = vi.fn();
  const onChunk = vi.fn();
  const onCompleted = vi.fn();
  const service = createNativeGeminiService({
    invokeCommand,
    ChannelConstructor: TestChannel,
  });

  await expect(service.startGeminiJob(nativeRequest({
    projectId,
    expectedProjectStateVersion: 11,
  }), {
    onEvent,
    onChunk,
    onCompleted,
  })).resolves.toEqual(initial);
  expect(invokeCommand.mock.calls[0][1].request).not.toHaveProperty('apiKey');
  expect(invokeCommand.mock.calls[0][1].request).toMatchObject({
    projectId,
    expectedProjectStateVersion: 11,
  });

  channel.emit({ event: 'chunk', jobId: initial.id, text: 'hello ' });
  channel.emit({
    event: 'completed',
    deliveryId: uuidv7(),
    job: jobSnapshot({ id: initial.id, state: 'succeeded', progress: { basisPoints: 10_000 }, sequence: 2 }),
    text: 'hello world',
    usage: {
      promptTokenCount: 10,
      candidatesTokenCount: 2,
      totalTokenCount: 12,
      thoughtsTokenCount: null,
      cachedContentTokenCount: null,
    },
  });

  expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({
    event: 'chunk',
    text: 'hello ',
  }));
  expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
    event: 'completed',
    text: 'hello world',
  }));
  expect(onEvent).toHaveBeenCalledTimes(2);
});

it('buffers an early Channel event until the initial JobSnapshot is validated', async () => {
  const initial = jobSnapshot();
  let resolveInvoke;
  const invokeCommand = vi.fn((command, args) => {
    args.onEvent.emit({ event: 'chunk', jobId: initial.id, text: 'early' });
    return new Promise((resolve) => { resolveInvoke = resolve; });
  });
  const onChunk = vi.fn();
  const service = createNativeGeminiService({
    invokeCommand,
    ChannelConstructor: TestChannel,
  });

  const started = service.startGeminiJob(nativeRequest(), { onChunk });
  expect(onChunk).not.toHaveBeenCalled();
  resolveInvoke(initial);
  await started;
  expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ text: 'early' }));
});

it('reports malformed, mismatched, duplicate-terminal, and handler failures safely', async () => {
  const initial = jobSnapshot();
  let channel;
  const onProtocolError = vi.fn();
  const onHandlerError = vi.fn();
  const service = createNativeGeminiService({
    invokeCommand: vi.fn(async (command, args) => {
      channel = args.onEvent;
      return initial;
    }),
    ChannelConstructor: TestChannel,
  });
  await service.startGeminiJob(nativeRequest(), {
    onChunk: () => { throw new Error('consumer failed'); },
    onProtocolError,
    onHandlerError,
  });

  channel.emit({ event: 'chunk', jobId: initial.id, text: 'valid' });
  expect(onHandlerError).toHaveBeenCalledWith(expect.any(Error));
  channel.emit({ event: 'chunk', jobId: uuidv7(), text: 'wrong job' });
  channel.emit({ event: 'unknown', text: 'bad event' });
  channel.emit({
    event: 'cancelled',
    job: jobSnapshot({ id: initial.id, state: 'cancelled', sequence: 2 }),
  });
  channel.emit({
    event: 'failed',
    job: jobSnapshot({ id: initial.id, state: 'failed', sequence: 3 }),
    error: { code: 'geminiProvider', message: 'late' },
  });
  expect(onProtocolError).toHaveBeenCalledTimes(3);
});

it('isolates asynchronous handler rejection and snapshots the handler set at start', async () => {
  const initial = jobSnapshot();
  let channel;
  const originalChunkHandler = vi.fn().mockRejectedValue(new Error('async consumer failed'));
  const replacementChunkHandler = vi.fn();
  const onHandlerError = vi.fn();
  const handlers = { onChunk: originalChunkHandler, onHandlerError };
  const service = createNativeGeminiService({
    invokeCommand: vi.fn(async (command, args) => {
      channel = args.onEvent;
      return initial;
    }),
    ChannelConstructor: TestChannel,
  });
  await service.startGeminiJob(nativeRequest(), handlers);
  handlers.onChunk = replacementChunkHandler;

  channel.emit({ event: 'chunk', jobId: initial.id, text: 'valid' });
  await Promise.resolve();
  await Promise.resolve();

  expect(originalChunkHandler).toHaveBeenCalledTimes(1);
  expect(replacementChunkHandler).not.toHaveBeenCalled();
  expect(onHandlerError).toHaveBeenCalledWith(expect.any(Error));
});

it('normalizes failed events without copying unknown diagnostic fields', () => {
  const raw = {
    event: 'failed',
    job: null,
    error: {
      code: 'geminiNetwork',
      message: 'Could not connect',
      rawProviderBody: 'private diagnostic',
    },
    apiKey: 'private key',
  };

  const event = normalizeGeminiJobEvent(raw);
  expect(event).toEqual({
    event: 'failed',
    job: null,
    error: { code: 'geminiNetwork', message: 'Could not connect' },
  });
  expect(JSON.stringify(event)).not.toContain('private');
});

it('validates and invokes generic native job cancellation', async () => {
  const initial = jobSnapshot();
  const cancelling = jobSnapshot({
    id: initial.id,
    state: 'cancelling',
    sequence: 2,
  });
  const invokeCommand = vi.fn().mockResolvedValue(cancelling);
  const service = createNativeGeminiService({ invokeCommand, ChannelConstructor: TestChannel });

  await expect(service.cancelGeminiJob(initial.id)).resolves.toEqual(cancelling);
  expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  await expect(service.cancelGeminiJob('not-a-job-id'))
    .rejects.toMatchObject({ code: 'invalidGeminiRequest' });
});

it('uses an explicit legacy fallback only in a browser and never after a native failure', async () => {
  const browserFallback = vi.fn().mockResolvedValue('legacy result');
  const browserInvoke = vi.fn();
  const browserService = createNativeGeminiService({
    invokeCommand: browserInvoke,
    ChannelConstructor: TestChannel,
    isNativeRuntime: () => false,
  });
  await expect(browserService.runGeminiWithBrowserFallback({
    nativeRequest: nativeRequest(),
    browserFallback,
  })).resolves.toBe('legacy result');
  expect(browserInvoke).not.toHaveBeenCalled();

  const nativeInvoke = vi.fn().mockRejectedValue(new Error('native unavailable'));
  const nativeFallback = vi.fn();
  const nativeService = createNativeGeminiService({
    invokeCommand: nativeInvoke,
    ChannelConstructor: TestChannel,
    isNativeRuntime: () => true,
  });
  await expect(nativeService.runGeminiWithBrowserFallback({
    nativeRequest: nativeRequest(),
    browserFallback: nativeFallback,
  })).rejects.toThrow('native unavailable');
  expect(nativeFallback).not.toHaveBeenCalled();
});

it('requires an explicit fallback in a browser', async () => {
  const service = createNativeGeminiService({
    invokeCommand: vi.fn(),
    ChannelConstructor: TestChannel,
    isNativeRuntime: () => false,
  });
  await expect(service.runGeminiWithBrowserFallback({ nativeRequest: nativeRequest() }))
    .rejects.toMatchObject({ code: 'browserGeminiFallbackRequired' });
});

it('rejects malformed job snapshots at the trust boundary', () => {
  expect(() => normalizeJobSnapshot(jobSnapshot({ sequence: -1 })))
    .toThrow(GeminiServiceError);
  expect(() => normalizeJobSnapshot(jobSnapshot({ progress: { basisPoints: 10_001 } })))
    .toThrow(GeminiServiceError);
  expect(() => normalizeJobSnapshot(jobSnapshot({ state: 'queued', sequence: 1 })))
    .toThrow(GeminiServiceError);
  expect(() => normalizeJobSnapshot(jobSnapshot({
    state: 'succeeded',
    progress: { basisPoints: 9_999 },
    sequence: 2,
  }))).toThrow(GeminiServiceError);
});
