import { createNativeGeminiImage } from './nativeGeminiImage';
import {
  JOB_A,
  PROJECT_A,
  PROJECT_B,
  ARTIFACT_A,
  PLAYBACK_A,
  REFERENCE_PLAYBACK_URL,
  snapshot,
  playable,
  createHarness,
} from './nativeGeminiImageTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({ Channel: class {} }));

test('production project lookup resolves the exact current cache instead of persisted last-active state', async () => {
  const resolveProject = vi.fn().mockResolvedValue({ cacheId: 'cache-b', projectId: PROJECT_B });
  const service = createNativeGeminiImage({
    getCacheId: () => 'cache-b',
    resolveProject,
    isNativeRuntime: () => true,
  });

  await expect(service.getActiveProjectId()).resolves.toBe(PROJECT_B);
  expect(resolveProject).toHaveBeenCalledWith('cache-b', { create: true });
});

test('completion that wins an abort race returns its committed capability for exact release', async () => {
  let channelArgs;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const harness = createHarness({
    invokeImplementation: async (command, args) => {
      if (command === 'gemini_image_start') {
        channelArgs = args;
        return snapshot(JOB_A, 'running');
      }
      if (command === 'gemini_image_complete') return completion;
      if (command === 'generated_image_playback_release') return true;
      throw new Error(`unexpected command ${command}`);
    },
  });
  const controller = new AbortController();
  const generation = harness.service.generate({
    referencePlaybackUrl: REFERENCE_PLAYBACK_URL,
    prompt: 'Generate',
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(channelArgs).toBeDefined());
  const prepared = {
    event: 'prepared',
    job: snapshot(JOB_A, 'running'),
    image: playable(),
  };
  channelArgs.onEvent.onmessage(prepared);
  await vi.waitFor(() => expect(harness.invokeCommand)
    .toHaveBeenCalledWith('gemini_image_complete', expect.any(Object)));

  controller.abort();
  resolveCompletion(snapshot(JOB_A, 'succeeded', 2));
  const result = await generation;
  expect(result.job.state).toBe('succeeded');
  expect(harness.cancel).toHaveBeenCalledWith(JOB_A);
  expect(harness.invokeCommand.mock.calls.filter(([command]) => (
    command === 'generated_image_playback_release'
  ))).toHaveLength(0);
  await harness.service.releasePlayback(result.image);
  expect(harness.invokeCommand).toHaveBeenCalledWith(
    'generated_image_playback_release',
    {
      request: {
        projectId: PROJECT_A,
        artifactId: ARTIFACT_A,
        playbackId: PLAYBACK_A,
      },
    }
  );
  channelArgs.onEvent.onmessage(prepared);
  await Promise.resolve();
  expect(harness.invokeCommand.mock.calls.filter(([command]) => (
    command === 'generated_image_playback_release'
  ))).toHaveLength(1);
});

test('cancellation that wins during acknowledgement rejects and releases the capability once', async () => {
  let channelArgs;
  let rejectCompletion;
  const completion = new Promise((_resolve, reject) => { rejectCompletion = reject; });
  const harness = createHarness({
    invokeImplementation: async (command, args) => {
      if (command === 'gemini_image_start') {
        channelArgs = args;
        return snapshot(JOB_A, 'running');
      }
      if (command === 'gemini_image_complete') return completion;
      if (command === 'generated_image_playback_release') return true;
      throw new Error(`unexpected command ${command}`);
    },
  });
  const controller = new AbortController();
  const generation = harness.service.generate({
    referencePlaybackUrl: REFERENCE_PLAYBACK_URL,
    prompt: 'Generate',
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(channelArgs).toBeDefined());
  channelArgs.onEvent.onmessage({
    event: 'prepared',
    job: snapshot(JOB_A, 'running'),
    image: playable(),
  });
  await vi.waitFor(() => expect(harness.invokeCommand)
    .toHaveBeenCalledWith('gemini_image_complete', expect.any(Object)));

  controller.abort();
  rejectCompletion(Object.assign(new Error('cancellation won'), { code: 'jobConflict' }));

  await expect(generation).rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.cancel).toHaveBeenCalledWith(JOB_A);
  await vi.waitFor(() => expect(harness.invokeCommand.mock.calls.filter(([command]) => (
    command === 'generated_image_playback_release'
  ))).toHaveLength(1));
});

test('a prepared capability arriving after an early abort is never acknowledged and is released once', async () => {
  let channelArgs;
  let resolveStart;
  const harness = createHarness({
    invokeImplementation: async (command, args) => {
      if (command === 'gemini_image_start') {
        channelArgs = args;
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'generated_image_playback_release') return true;
      throw new Error(`unexpected command ${command}`);
    },
  });
  const controller = new AbortController();
  const generation = harness.service.generate({
    referencePlaybackUrl: REFERENCE_PLAYBACK_URL,
    prompt: 'Generate',
    signal: controller.signal,
  });
  await vi.waitFor(() => expect(channelArgs).toBeDefined());
  controller.abort();
  channelArgs.onEvent.onmessage({
    event: 'prepared',
    job: snapshot(JOB_A, 'running'),
    image: playable(),
  });
  resolveStart(snapshot(JOB_A, 'running'));

  await expect(generation).rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.invokeCommand.mock.calls.filter(([command]) => (
    command === 'gemini_image_complete'
  ))).toHaveLength(0);
  await vi.waitFor(() => expect(harness.invokeCommand.mock.calls.filter(([command]) => (
    command === 'generated_image_playback_release'
  ))).toHaveLength(1));
});

test('a lost completion response retries the exact acknowledgement without duplicate release', async () => {
  let completionCalls = 0;
  const harness = createHarness({
    invokeImplementation: async (command, args) => {
      if (command === 'gemini_image_complete') {
        completionCalls += 1;
        if (completionCalls === 1) throw new Error('response lost after commit');
        return snapshot(args.request.jobId, 'succeeded', 2);
      }
      if (command === 'generated_image_playback_release') return true;
      queueMicrotask(() => args.onEvent.onmessage({
        event: 'prepared',
        job: snapshot(JOB_A, 'running'),
        image: playable(),
      }));
      return snapshot(JOB_A, 'running');
    },
  });

  await expect(harness.service.generate({
    referencePlaybackUrl: REFERENCE_PLAYBACK_URL,
    prompt: 'Generate',
  })).resolves.toMatchObject({ job: { state: 'succeeded' } });
  expect(completionCalls).toBe(2);
  expect(harness.invokeCommand.mock.calls.filter(([command]) => (
    command === 'generated_image_playback_release'
  ))).toHaveLength(0);
});

test('a failed completion acknowledgement releases the prepared playback exactly once', async () => {
  const harness = createHarness({
    invokeImplementation: async (command, args) => {
      if (command === 'generated_image_playback_release') return true;
      if (command === 'gemini_image_complete') {
        throw Object.assign(new Error('ack failed'), { code: 'nativeGeminiImageFailed' });
      }
      queueMicrotask(() => args.onEvent.onmessage({
        event: 'prepared',
        job: snapshot(JOB_A, 'running'),
        image: playable(),
      }));
      return snapshot(JOB_A, 'running');
    },
  });

  await expect(harness.service.generate({
    referencePlaybackUrl: REFERENCE_PLAYBACK_URL,
    prompt: 'Generate',
  })).rejects.toMatchObject({ code: 'nativeGeminiImageFailed' });
  expect(harness.invokeCommand.mock.calls.filter(([command]) => (
    command === 'generated_image_playback_release'
  ))).toHaveLength(1);
});
