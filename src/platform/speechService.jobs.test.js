import { createNativeSpeechService, createSpeechLifecycleState } from './speechService';
import {
  ARTIFACT_ID,
  EDITED_ARTIFACT_ID,
  FakeChannel,
  JOB_ID,
  PROJECT_ID,
  artifact,
  backendStatus,
  job,
  runningLifecycleState,
} from './speechServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

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
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
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
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
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
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
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
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
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
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
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
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
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
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      results: [{ status: 'completed', segmentId: 'one' }],
    });
    expect(invokeCommand).toHaveBeenCalledWith('speech_job_results', { jobId: JOB_ID });
  });
});
