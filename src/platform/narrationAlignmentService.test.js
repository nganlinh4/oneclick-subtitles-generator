import {
  createNativeNarrationAlignmentService,
  normalizeAlignmentRequest,
  normalizeAlignmentResult,
} from './narrationAlignmentService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
const OTHER_JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';

class FakeChannel {
  constructor() {
    this.onmessage = null;
  }
}

const job = (state = 'running', sequence = 1, basisPoints = 0, id = JOB_ID) => ({
  id,
  kind: 'alignNarration',
  state,
  progress: { basisPoints },
  sequence,
});

const result = () => ({
  artifact: {
    artifactId: ARTIFACT_ID,
    format: 'm4a',
    bytes: 32_000,
    durationMicros: 3_250_000,
    sampleRateHz: 48_000,
    channels: 2,
  },
  clipCount: 2,
  adjustedCount: 1,
  requestedDurationMicros: 3_000_000,
  naturalDurationMicros: 3_000_000,
  renderedDurationMicros: 3_250_000,
  maximumShiftMicros: 800_000,
});

const request = () => ({
  clips: [{
    id: 'segment-1',
    artifactId: ARTIFACT_ID,
    startMicros: 0,
    cueEndMicros: 1_000_000,
  }],
});

describe('native narration alignment validation', () => {
  test('accepts only opaque artifacts and bounded integer timing', () => {
    expect(normalizeAlignmentRequest(request())).toEqual(request());
    expect(() => normalizeAlignmentRequest({
      clips: [{ ...request().clips[0], path: 'C:\\private.wav' }],
    })).toThrow('invalid');
    expect(() => normalizeAlignmentRequest({
      clips: [{ ...request().clips[0], audioData: 'base64-secret' }],
    })).toThrow('invalid');
    expect(() => normalizeAlignmentRequest({
      clips: [{ ...request().clips[0], startMicros: 0.5 }],
    })).toThrow('invalid');
  });

  test('requires the fixed durable aligned-audio result contract', () => {
    expect(normalizeAlignmentResult(result()).artifact.format).toBe('m4a');
    expect(() => normalizeAlignmentResult({
      ...result(),
      artifact: { ...result().artifact, sampleRateHz: 24_000 },
    })).toThrow('invalid');
    expect(() => normalizeAlignmentResult({
      ...result(),
      renderedDurationMicros: 3_000_000,
    })).toThrow('invalid');
  });
});

describe('native narration alignment lifecycle', () => {
  test('buffers a terminal event delivered before the start response', async () => {
    const onCompleted = vi.fn();
    const invokeCommand = vi.fn(async (command, args) => {
      if (command !== 'speech_alignment_start') throw new Error('unexpected command');
      args.onEvent.onmessage({
        event: 'completed',
        job: job('succeeded', 2, 10_000),
        result: result(),
      });
      return job();
    });
    const service = createNativeNarrationAlignmentService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.startAlignmentJob(request(), { onCompleted })).resolves.toEqual(job());
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ event: 'completed' }));
  });

  test('cancels once when a competing AbortSignal fires repeatedly', async () => {
    let channel;
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'speech_alignment_start') {
        channel = args.onEvent;
        return job();
      }
      if (command === 'job_cancel') return job('cancelling', 2, 0);
      throw new Error('unexpected command');
    });
    const service = createNativeNarrationAlignmentService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    const controller = new AbortController();
    await service.startAlignmentJob(request(), {}, { signal: controller.signal });
    controller.abort();
    controller.abort();
    await Promise.resolve();
    expect(channel).toBeDefined();
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toHaveLength(1);
  });

  test('fails closed and cancels a mismatched channel job', async () => {
    let channel;
    const onProtocolError = vi.fn();
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'speech_alignment_start') {
        channel = args.onEvent;
        return job();
      }
      if (command === 'job_cancel') return job('cancelling', 2, 0);
      throw new Error('unexpected command');
    });
    const service = createNativeNarrationAlignmentService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await service.startAlignmentJob(request(), { onProtocolError });
    channel.onmessage({
      event: 'progress',
      jobId: OTHER_JOB_ID,
      phase: 'mixing',
      fractionMillionths: 100,
    });
    await Promise.resolve();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toHaveLength(1);
  });

  test('restores a committed artifact without a live channel', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_alignment_result') {
        return { job: job('interrupted', 3, 9_500), result: result() };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeNarrationAlignmentService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.getAlignmentResult(JOB_ID)).resolves.toEqual({
      job: job('interrupted', 3, 9_500),
      result: normalizeAlignmentResult(result()),
    });
  });
});
