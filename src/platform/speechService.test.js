import {
  GEMINI_SPEECH_MODELS,
  MAX_SPEECH_BATCH_BYTES,
  MAX_SPEECH_SEGMENTS,
  createNativeSpeechService,
  createSpeechLifecycleState,
  normalizeSpeechProfile,
  normalizeSpeechStartRequest,
  normalizeSpeechStatus,
} from './speechService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const EDITED_ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const TOKEN = 'a'.repeat(64);

class FakeChannel {
  constructor() {
    this.onmessage = null;
  }
}

const job = (state = 'running', sequence = 1, basisPoints = 0) => ({
  id: JOB_ID,
  kind: 'synthesizeNarration',
  state,
  progress: { basisPoints },
  sequence,
});

const artifact = () => ({
  artifactId: ARTIFACT_ID,
  format: 'wav',
  bytes: 4_096,
  durationMicros: 1_000_000,
  sampleRateHz: 24_000,
  channels: 1,
});

const playable = () => ({
  artifact: artifact(),
  playback: {
    id: PLAYBACK_ID,
    playbackUrl: `http://127.0.0.1:43210/asset/${PLAYBACK_ID}?token=${TOKEN}`,
    mimeType: 'audio/wav',
    byteLength: 4_096,
  },
});

const backendStatus = (backend, overrides = {}) => ({
  backend,
  epoch: 0,
  enabled: false,
  installed: false,
  ready: false,
  warm: false,
  requiresReference: backend === 'f5Tts' || backend === 'chatterbox',
  supportsVoiceInventory: ['edgeTts', 'gtts', 'geminiTts'].includes(backend),
  supportsVoiceConversion: backend === 'chatterbox',
  requiresCredential: backend === 'geminiTts',
  ...overrides,
});

const runningLifecycleState = (backend = 'gtts', epoch = 0) => {
  const lifecycleState = createSpeechLifecycleState();
  lifecycleState.apply(backendStatus(backend, {
    epoch, enabled: true, installed: true, ready: true, warm: true,
  }));
  return lifecycleState;
};

const status = () => ({
  backends: [
    backendStatus('f5Tts'),
    backendStatus('chatterbox'),
    backendStatus('edgeTts'),
    backendStatus('gtts'),
    backendStatus('geminiTts'),
  ],
  maxSegmentsPerJob: MAX_SPEECH_SEGMENTS,
  maxBatchTextBytes: MAX_SPEECH_BATCH_BYTES,
});

describe('native speech request validation', () => {
  test('normalizes useful defaults for every supported backend', () => {
    expect(normalizeSpeechProfile({ backend: 'f5Tts' })).toEqual({
      backend: 'f5Tts',
      referenceText: null,
      model: null,
      speechRateMilli: 1_100,
      nfeSteps: 32,
      swayMilli: -1_000,
      guidanceMilli: 2_000,
      seed: null,
      removeSilence: true,
    });
    expect(normalizeSpeechProfile({
      backend: 'chatterbox',
      language: 'ko',
    })).toMatchObject({ exaggerationMilli: 1_000, cfgWeightMilli: 500 });
    expect(normalizeSpeechProfile({
      backend: 'edgeTts',
      voice: 'en-US-AriaNeural',
    })).toMatchObject({ ratePercent: 0, volumePercent: 0, pitchHz: 0 });
    expect(normalizeSpeechProfile({
      backend: 'gtts',
      language: 'en',
    })).toEqual({ backend: 'gtts', language: 'en', domain: 'com', slow: false });
    expect(normalizeSpeechProfile({
      backend: 'geminiTts',
      credentialId: JOB_ID,
    })).toMatchObject({
      model: GEMINI_SPEECH_MODELS[0],
      voice: 'Aoede',
      language: 'en-US',
    });
  });

  test('requires an opaque reference only for reference-based engines', () => {
    expect(() => normalizeSpeechStartRequest({
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'f5Tts' },
      referenceArtifactId: null,
    })).toThrow('invalid');
    expect(() => normalizeSpeechStartRequest({
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'gtts', language: 'en' },
      referenceArtifactId: ARTIFACT_ID,
    })).toThrow('invalid');
  });

  test('rejects duplicate IDs, controls, oversized Chatterbox text, and unknown options', () => {
    expect(() => normalizeSpeechStartRequest({
      lifecycleEpoch: 0,
      segments: [{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }],
      profile: { backend: 'gtts', language: 'en' },
    })).toThrow('invalid');
    expect(() => normalizeSpeechStartRequest({
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'a\u0000b' }],
      profile: { backend: 'gtts', language: 'en' },
    })).toThrow('invalid');
    expect(() => normalizeSpeechStartRequest({
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'x'.repeat(301) }],
      profile: { backend: 'chatterbox' },
      referenceArtifactId: ARTIFACT_ID,
    })).toThrow('invalid');
    expect(() => normalizeSpeechProfile({
      backend: 'geminiTts',
      credentialId: JOB_ID,
      apiKey: 'must-not-cross',
    })).toThrow('invalid');
  });
});

describe('native speech response validation', () => {
  test('accepts a complete status catalog and rejects impossible readiness', () => {
    expect(normalizeSpeechStatus(status()).backends).toHaveLength(5);
    const invalid = status();
    invalid.backends[0] = backendStatus('f5Tts', { ready: true });
    expect(() => normalizeSpeechStatus(invalid)).toThrow('invalid');
  });

  test('reads cached warm inventory through the non-starting native command only', async () => {
    const lifecycleState = createSpeechLifecycleState();
    lifecycleState.apply(backendStatus('edgeTts', {
      epoch: 7, enabled: true, installed: true, ready: true, warm: true,
    }));
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_voice_inventory') {
        return {
          backend: 'edgeTts',
          epoch: 7,
          enabled: true,
          warm: true,
          voices: [{
            id: 'en-US-AriaNeural',
            displayName: 'Aria',
            language: 'en-US',
            gender: 'female',
          }],
        };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });

    await expect(service.getSpeechVoiceInventory('edgeTts', 7)).resolves.toMatchObject({
      backend: 'edgeTts',
      epoch: 7,
      voices: [{ id: 'en-US-AriaNeural' }],
    });
    expect(invokeCommand).toHaveBeenCalledExactlyOnceWith(
      'speech_voice_inventory',
      { backend: 'edgeTts', epoch: 7 }
    );
    expect(invokeCommand).not.toHaveBeenCalledWith('speech_probe', expect.anything());
    expect(invokeCommand).not.toHaveBeenCalledWith('speech_start', expect.anything());
    await expect(service.getSpeechVoiceInventory('f5Tts', 7)).rejects.toMatchObject({
      code: 'invalidSpeechRequest',
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  test('rejects inventory returned for a different backend', async () => {
    const lifecycleState = createSpeechLifecycleState();
    lifecycleState.apply(backendStatus('edgeTts', {
      epoch: 4, enabled: true, installed: true, ready: true, warm: true,
    }));
    const service = createNativeSpeechService({
      invokeCommand: vi.fn(async () => ({
        backend: 'gtts', epoch: 4, enabled: true, warm: true, voices: [],
      })),
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });
    await expect(service.getSpeechVoiceInventory('edgeTts', 4)).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });
  });

  test('rejects late inventory and stale starts after an authoritative Stop epoch', async () => {
    const lifecycleState = createSpeechLifecycleState();
    const running = backendStatus('edgeTts', {
      epoch: 9, enabled: true, installed: true, ready: true, warm: true,
    });
    lifecycleState.apply(running);
    let resolveInventory;
    const invokeCommand = vi.fn((command) => {
      if (command === 'speech_voice_inventory') {
        return new Promise((resolve) => { resolveInventory = resolve; });
      }
      if (command === 'speech_runtime_stop') {
        return Promise.resolve(backendStatus('edgeTts', {
          epoch: 10, enabled: false, installed: true, ready: false, warm: false,
        }));
      }
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });
    const lifecycleObserver = vi.fn();
    lifecycleState.subscribe(lifecycleObserver);
    const lateInventory = service.getSpeechVoiceInventory('edgeTts', 9);

    await expect(service.stopSpeechRuntime('edgeTts')).resolves.toMatchObject({
      epoch: 10, enabled: false, warm: false,
    });
    expect(lifecycleObserver).toHaveBeenLastCalledWith(expect.objectContaining({
      backend: 'edgeTts', epoch: 10, enabled: false, warm: false,
    }));
    lifecycleState.apply(running);
    expect(lifecycleState.getSnapshot('edgeTts')).toMatchObject({
      epoch: 10, enabled: false, warm: false,
    });
    resolveInventory({
      backend: 'edgeTts', epoch: 9, enabled: true, warm: true, voices: [],
    });
    await expect(lateInventory).rejects.toMatchObject({ code: 'speechRuntimeStopped' });
    await expect(service.startSpeechJob({
      lifecycleEpoch: 9,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'edgeTts', voice: 'en-US-AriaNeural' },
    })).rejects.toMatchObject({ code: 'speechRuntimeStopped' });
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'speech_start')).toHaveLength(0);
  });

  test('accepts only scoped loopback playback URLs', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_artifact_resolve') return playable();
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.resolveSpeechArtifact(ARTIFACT_ID)).resolves.toMatchObject({
      artifact: { artifactId: ARTIFACT_ID },
      playback: { id: PLAYBACK_ID },
    });

    invokeCommand.mockImplementationOnce(async () => ({
      ...playable(),
      playback: {
        ...playable().playback,
        playbackUrl: `https://attacker.invalid/asset/${PLAYBACK_ID}?token=${TOKEN}`,
      },
    }));
    await expect(service.resolveSpeechArtifact(ARTIFACT_ID)).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });
  });

  test('imports opaque audio assets and emits fixed-point edit requests only', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_reference_import') return playable();
      if (command === 'speech_artifact_edit') {
        return { ...artifact(), artifactId: EDITED_ARTIFACT_ID, durationMicros: 500_000 };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.importSpeechReference({
      backend: 'f5Tts',
      assetId: JOB_ID,
    })).resolves.toMatchObject({ artifact: { artifactId: ARTIFACT_ID } });
    expect(invokeCommand).toHaveBeenCalledWith('speech_reference_import', {
      request: { backend: 'f5Tts', assetId: JOB_ID },
    });
    await expect(service.editSpeechArtifact({
      artifactId: ARTIFACT_ID,
      normalizedStart: 0.125,
      normalizedEnd: 0.875,
      speedFactor: 1.5,
    })).resolves.toMatchObject({ artifactId: EDITED_ARTIFACT_ID });
    expect(invokeCommand).toHaveBeenCalledWith('speech_artifact_edit', {
      request: {
        artifactId: ARTIFACT_ID,
        normalizedStartMillionths: 125_000,
        normalizedEndMillionths: 875_000,
        speedMilli: 1_500,
      },
    });
    await expect(service.importSpeechReference({
      backend: 'f5Tts',
      assetId: JOB_ID,
      filepath: 'C:/private/reference.wav',
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
    await expect(service.editSpeechArtifact({
      artifactId: ARTIFACT_ID,
      normalizedStart: 0,
      normalizedEnd: 1,
      speedFactor: 1,
      outputPath: 'C:/private/output.wav',
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
  });

  test('exports only opaque artifacts and safe leaf names through native save UI', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_artifact_export') return true;
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.exportSpeechArtifacts({
      entries: [{ artifactId: ARTIFACT_ID, fileName: 'narration_1.wav' }],
      archiveName: null,
    })).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith('speech_artifact_export', {
      request: {
        entries: [{ artifactId: ARTIFACT_ID, fileName: 'narration_1.wav' }],
        archiveName: null,
      },
    });
    expect(JSON.stringify(invokeCommand.mock.calls[0][1])).not.toMatch(
      /(?:127\.0\.0\.1|localhost|token=|playbackUrl|audioUrl|[A-Za-z]:[\\/])/i
    );
    await expect(service.exportSpeechArtifacts({
      entries: [{
        artifactId: ARTIFACT_ID,
        fileName: '../private.wav',
        outputPath: 'C:/private/audio.wav',
      }],
      archiveName: null,
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });
});

describe('native speech job lifecycle', () => {
  test('pins voice conversion to Chatterbox epoch and cancels a late cross-Stop start', async () => {
    const lifecycleState = createSpeechLifecycleState();
    lifecycleState.apply(backendStatus('chatterbox', {
      epoch: 20, enabled: true, installed: true, ready: true, warm: true,
    }));
    let resolveStart;
    const invokeCommand = vi.fn((command) => {
      if (command === 'speech_voice_conversion_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') return Promise.resolve(job('cancelling', 2, 0));
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });
    const conversion = service.startVoiceConversionJob({
      inputArtifactId: ARTIFACT_ID,
      targetVoiceArtifactId: EDITED_ARTIFACT_ID,
      lifecycleEpoch: 20,
    });
    await vi.waitFor(() => expect(resolveStart).toBeTypeOf('function'));

    lifecycleState.apply(backendStatus('chatterbox', {
      epoch: 21, enabled: false, installed: true, ready: false, warm: false,
    }));
    lifecycleState.apply(backendStatus('chatterbox', {
      epoch: 21, enabled: true, installed: true, ready: true, warm: true,
    }));
    resolveStart(job());

    await expect(conversion).rejects.toMatchObject({ code: 'speechRuntimeStopped' });
    expect(invokeCommand).toHaveBeenCalledWith('speech_voice_conversion_start', {
      request: {
        inputArtifactId: ARTIFACT_ID,
        targetVoiceArtifactId: EDITED_ARTIFACT_ID,
        lifecycleEpoch: 20,
      },
      onEvent: expect.any(FakeChannel),
    });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: JOB_ID });
  });

  test('voice conversion fails closed without Chatterbox ownership and ignores other backends', async () => {
    const lifecycleState = createSpeechLifecycleState();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_voice_conversion_start') return job();
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });
    const request = {
      inputArtifactId: ARTIFACT_ID,
      targetVoiceArtifactId: EDITED_ARTIFACT_ID,
      lifecycleEpoch: 4,
    };
    await expect(service.startVoiceConversionJob(request)).rejects.toMatchObject({
      code: 'speechRuntimeStopped',
    });
    expect(invokeCommand).not.toHaveBeenCalled();

    lifecycleState.apply(backendStatus('chatterbox', {
      epoch: 4, enabled: true, installed: true, ready: true, warm: true,
    }));
    lifecycleState.apply(backendStatus('edgeTts', {
      epoch: 8, enabled: false, installed: true, ready: false, warm: false,
    }));
    await expect(service.startVoiceConversionJob(request)).resolves.toEqual(job());
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  test('buffers early events, dispatches typed results, and keeps artifacts opaque', async () => {
    const onResult = vi.fn();
    const onComplete = vi.fn();
    const invokeCommand = vi.fn(async (command, args) => {
      if (command !== 'speech_start') throw new Error('unexpected command');
      args.onEvent.onmessage({
        event: 'segmentCompleted',
        jobId: JOB_ID,
        index: 1,
        total: 1,
        result: { status: 'completed', segmentId: 'one', artifact: artifact() },
      });
      args.onEvent.onmessage({
        event: 'completed',
        job: job('succeeded', 3, 10_000),
        results: [{ status: 'completed', segmentId: 'one', artifact: artifact() }],
      });
      return job();
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState: runningLifecycleState(),
    });
    await expect(service.startSpeechJob({
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'private words' }],
      profile: { backend: 'gtts', language: 'en' },
    }, {
      onSegmentCompleted: onResult,
      onCompleted: onComplete,
    })).resolves.toEqual(job());
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        artifact: expect.objectContaining({ artifactId: ARTIFACT_ID }),
      }),
    }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    const sent = invokeCommand.mock.calls[0][1].request;
    expect(sent).not.toHaveProperty('path');
    expect(JSON.stringify(sent)).not.toContain('apiKey');
  });

  test('cancels the durable job when a channel frame violates the contract', async () => {
    let channel;
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'speech_start') {
        channel = args.onEvent;
        return job();
      }
      if (command === 'job_cancel') return job('cancelling', 2, 0);
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState: runningLifecycleState(),
    });
    await service.startSpeechJob({
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'gtts', language: 'en' },
    }, { onProtocolError });
    channel.onmessage({ event: 'progress', nativePath: 'C:\\private.wav' });
    await Promise.resolve();
    await Promise.resolve();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: JOB_ID });
  });

  test('rejects a terminal frame that omits an already streamed result', async () => {
    let channel;
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'speech_start') {
        channel = args.onEvent;
        return job();
      }
      if (command === 'job_cancel') return job('cancelling', 2, 0);
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState: runningLifecycleState(),
    });
    await service.startSpeechJob({
      lifecycleEpoch: 0,
      segments: [
        { id: 'one', text: 'hello' },
        { id: 'two', text: 'world' },
      ],
      profile: { backend: 'gtts', language: 'en' },
    }, { onProtocolError });
    channel.onmessage({
      event: 'segmentFailed',
      jobId: JOB_ID,
      index: 1,
      total: 2,
      result: {
        status: 'failed',
        segmentId: 'one',
        code: 'synthesisFailed',
        retryable: false,
      },
    });
    channel.onmessage({
      event: 'failed',
      job: job('failed', 3, 0),
      results: [],
      code: 'synthesisFailed',
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: JOB_ID });
  });

  test('quarantines an old job across Stop and restart without cancelling another backend', async () => {
    const lifecycleState = runningLifecycleState('gtts', 30);
    const lifecycleObserver = vi.fn();
    lifecycleState.subscribe(lifecycleObserver);
    let channel;
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'speech_start') {
        channel = args.onEvent;
        return job();
      }
      if (command === 'job_cancel') return job('cancelling', 2, 0);
      throw new Error('unexpected command');
    });
    const onProgress = vi.fn();
    const onSegmentCompleted = vi.fn();
    const onCompleted = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });
    await service.startSpeechJob({
      lifecycleEpoch: 30,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'gtts', language: 'en' },
    }, {
      onProgress, onSegmentCompleted, onCompleted, onProtocolError,
    });

    lifecycleState.apply(backendStatus('edgeTts', {
      epoch: 8, enabled: false, installed: true, ready: false, warm: false,
    }));
    await Promise.resolve();
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel'))
      .toHaveLength(0);

    lifecycleState.apply(backendStatus('gtts', {
      epoch: 31, enabled: false, installed: true, ready: false, warm: false,
    }));
    lifecycleState.apply(backendStatus('gtts', {
      epoch: 31, enabled: true, installed: true, ready: true, warm: true,
    }));
    channel.onmessage({ event: 'progress', nativePath: 'C:\\stale-output.wav' });
    channel.onmessage({
      event: 'segmentCompleted',
      jobId: JOB_ID,
      index: 1,
      total: 1,
      result: { status: 'completed', segmentId: 'one', artifact: artifact() },
    });
    channel.onmessage({
      event: 'completed',
      job: job('succeeded', 3, 10_000),
      results: [{ status: 'completed', segmentId: 'one', artifact: artifact() }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      code: 'speechRuntimeStopped',
    }));
    expect(onProgress).not.toHaveBeenCalled();
    expect(onSegmentCompleted).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel'))
      .toHaveLength(1);
    expect(lifecycleState.getSnapshot('gtts')).toMatchObject({
      epoch: 31, enabled: true, warm: true,
    });
    expect(lifecycleObserver).toHaveBeenLastCalledWith(expect.objectContaining({
      backend: 'gtts', epoch: 31, enabled: true,
    }));
  });

  test('bridges AbortSignal cancellation exactly once', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_start') return job();
      if (command === 'job_cancel') return job('cancelling', 2, 0);
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState: runningLifecycleState(),
    });
    const controller = new AbortController();
    await service.startSpeechJob({
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'gtts', language: 'en' },
    }, undefined, { signal: controller.signal });
    controller.abort();
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel'))
      .toHaveLength(1);
  });

  test('reloads durable job results after a WebView reconnect', async () => {
    const invokeCommand = vi.fn(async () => ({
      job: job('succeeded', 3, 10_000),
      backend: 'gtts',
      results: [{ status: 'completed', segmentId: 'one', artifact: artifact() }],
    }));
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.getSpeechJobResults(JOB_ID)).resolves.toMatchObject({
      job: { id: JOB_ID, state: 'succeeded' },
      backend: 'gtts',
      results: [{ status: 'completed', segmentId: 'one' }],
    });
    expect(invokeCommand).toHaveBeenCalledWith('speech_job_results', { jobId: JOB_ID });
  });
});
