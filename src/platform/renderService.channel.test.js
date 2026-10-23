// Native render lifecycle: channel event ordering, early terminals and start-response recovery.

import { v7 as uuidv7 } from 'uuid';

import { createNativeRenderService, runNativeRender } from './renderService';
import { TestChannel, job, request, result } from './renderServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('native render lifecycle: channel events', () => {
  test('buffers an initial same-sequence phase and then accepts a terminal result', async () => {
    let resolveStart;
    const initial = job();
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      throw new Error('unexpected command');
    });
    const onProgress = vi.fn();
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const renderRequest = request();
    const starting = service.start(renderRequest, { onProgress, onCompleted });
    TestChannel.latest.emit({
      event: 'progress',
      job: initial,
      phase: 'staging',
      fractionMillionths: 0,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: 75,
    });
    resolveStart(initial);
    await expect(starting).resolves.toEqual(initial);
    expect(onProgress).toHaveBeenCalledTimes(1);

    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: result({
        sourceAssetId: renderRequest.sourceAssetId,
        projectId: renderRequest.projectId,
      }),
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  test('a mismatched channel job fails closed and cancels only the started job', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onProtocolError });
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, id: uuidv7(), sequence: 2 },
      phase: 'staging',
      fractionMillionths: 1,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: 75,
    });
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('rejects regressing render phase, frame, and duration progress', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 4 };
      }
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onProtocolError });
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, progress: { basisPoints: 4_000 }, sequence: 2 },
      phase: 'encoding',
      fractionMillionths: 400_000,
      renderedFrames: 20,
      encodedFrames: 10,
      durationInFrames: 75,
    });
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, progress: { basisPoints: 4_001 }, sequence: 3 },
      phase: 'renderingFrames',
      fractionMillionths: 400_001,
      renderedFrames: 19,
      encodedFrames: 9,
      durationInFrames: 76,
    });
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('an early malformed event cancels the job returned after registration', async () => {
    let resolveStart;
    const initial = job();
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    });
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(request(), { onCompleted });
    TestChannel.latest.emit({ event: 'not-a-render-event' });
    resolveStart(initial);

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 3,
      },
      result: result(),
    });
    expect(onCompleted).not.toHaveBeenCalled();
  });

  test('cancel rejects a same-ID response that remains active without cancellation', async () => {
    const initial = job();
    const service = createNativeRenderService({
      invokeCommand: vi.fn().mockResolvedValue(initial),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.cancel(initial.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
  });

  test('run suppresses start notification after an early protocol terminal', async () => {
    let resolveStart;
    const initial = job();
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 2 });
      }
      throw new Error('unexpected command');
    });
    const onStarted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const running = runNativeRender(request(), { onStarted }, service);
    TestChannel.latest.emit({ event: 'not-a-render-event' });
    resolveStart(initial);

    await expect(running).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('run trusts an exact early completion when the start response is lost', async () => {
    const completed = {
      event: 'completed',
      job: job({
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      }),
      result: result(),
    };
    const onStarted = vi.fn();
    const service = {
      start: vi.fn(async (_request, handlers) => {
        handlers.onCompleted(completed);
        throw new Error('start response was lost');
      }),
      getResult: vi.fn(),
    };

    await expect(runNativeRender(request(), { onStarted }, service)).resolves.toBe(completed);
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('the real channel adapter preserves an early completion when start IPC is lost', async () => {
    let rejectStart;
    const renderRequest = request();
    const completedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completedResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((_resolve, reject) => { rejectStart = reject; });
      }
      throw new Error('unexpected command');
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const onStarted = vi.fn();
    const running = runNativeRender(renderRequest, { onStarted }, service);
    TestChannel.latest.emit({
      event: 'completed',
      job: completedJob,
      result: completedResult,
    });
    rejectStart({ code: 'internal', message: 'transport response lost' });

    await expect(running).resolves.toMatchObject({
      event: 'completed',
      job: completedJob,
      result: completedResult,
    });
    expect(onStarted).not.toHaveBeenCalled();
  });

  test('cancels a returned job ID when the start snapshot is malformed', async () => {
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return { ...initial, kind: 'downloadMedia' };
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.start(request(), {})).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });
});
