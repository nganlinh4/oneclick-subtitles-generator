// Native render lifecycle: ownership and quarantine of completed playback capabilities.

import { v7 as uuidv7 } from 'uuid';

import { createNativeRenderService } from './renderService';
import { TestChannel, job, request, result } from './renderServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('native render lifecycle: completed playback', () => {
  test('releases a mismatched completed playback and cancels its exact job', async () => {
    const renderRequest = request();
    const initial = job();
    const leaked = result({
      sourceAssetId: uuidv7(),
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 3 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError, onCompleted });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: leaked,
    });
    await Promise.resolve();

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: leaked.playback.id,
    });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
  });

  test('quarantines a single stale completed playback before protocol failure', async () => {
    const renderRequest = request();
    const initial = job();
    const staleResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted, onProtocolError });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
      },
      result: staleResult,
    });
    await Promise.resolve();

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(onProtocolError.mock.calls[0][0]).toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: staleResult.playback.id }]]);
  });

  test('stale completion quarantine is exact-once when playback release fails', async () => {
    const renderRequest = request();
    const initial = job();
    const staleResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') {
        throw new Error('cleanup transport failed');
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError });
    const staleEvent = {
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
      },
      result: staleResult,
    };
    TestChannel.latest.emit(staleEvent);
    TestChannel.latest.emit(staleEvent);
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(onProtocolError.mock.calls[0][0]).toMatchObject({
      code: 'invalidRenderResponse',
      message: 'The desktop host returned invalid native render data',
    });
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: staleResult.playback.id }]]);
  });

  test('stale completion quarantine never releases an already transferred playback', async () => {
    const renderRequest = request();
    const first = job();
    const second = job();
    const transferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    let startCalls = 0;
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') {
        startCalls += 1;
        return startCalls === 1 ? first : second;
      }
      if (command === 'job_cancel') {
        return { ...second, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...first,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: transferred,
    });
    expect(onCompleted).toHaveBeenCalledTimes(1);

    const onProtocolError = vi.fn();
    await service.start(renderRequest, { onProtocolError });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...second,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
      },
      result: transferred,
    });
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: second.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toHaveLength(0);
  });

  test('invalid foreign-job completion is neither accepted nor released', async () => {
    const renderRequest = request();
    const initial = job();
    const foreignJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const foreignResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted, onProtocolError });
    TestChannel.latest.emit({ event: 'completed', job: foreignJob, result: foreignResult });
    await Promise.resolve();

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toHaveLength(0);
  });

  test('releases an owned playback from a malformed completed envelope exactly once', async () => {
    const renderRequest = request();
    const initial = job();
    const completed = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 3 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error('unexpected command');
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError });
    const malformed = {
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: completed,
      unexpectedPath: 'C:\\private\\render.mp4',
    };
    TestChannel.latest.emit(malformed);
    TestChannel.latest.emit(malformed);
    await Promise.resolve();

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
  });

  test('quarantines duplicate completion capabilities without revoking the transferred result', async () => {
    const renderRequest = request();
    const initial = job();
    const accepted = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const duplicate = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted, onProtocolError });
    const completedJob = {
      ...initial,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    };
    TestChannel.latest.emit({ event: 'completed', job: completedJob, result: accepted });
    TestChannel.latest.emit({
      event: 'completed',
      job: { ...completedJob, id: 'invalid-job-id' },
      result: accepted,
      unexpectedPath: 'C:\\private\\accepted.mp4',
    });
    TestChannel.latest.emit({
      event: 'completed',
      job: { ...completedJob, id: 'invalid-job-id' },
      result: duplicate,
    });
    TestChannel.latest.emit({
      event: 'completed',
      job: { ...completedJob, id: 'invalid-job-id' },
      result: duplicate,
    });
    await Promise.resolve();

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: duplicate.playback.id }]]);
  });

  test('salvages a buffered invalid-job playback once even when release fails', async () => {
    let resolveStart;
    const renderRequest = request();
    const initial = job();
    const untransferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 2 });
      }
      if (command === 'render_playback_release') {
        return Promise.reject(new Error('cleanup transport failed'));
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(renderRequest, { onProtocolError });
    const malformed = {
      event: 'completed',
      job: {
        ...initial,
        id: 'invalid-job-id',
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: untransferred,
    };
    TestChannel.latest.emit(malformed);
    TestChannel.latest.emit(malformed);
    resolveStart(initial);

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    await Promise.resolve();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: untransferred.playback.id }]]);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toEqual([
      ['job_cancel', { id: initial.id }],
    ]);
  });

  test('salvages playback without executing a malformed job accessor', async () => {
    const renderRequest = request();
    const initial = job();
    const untransferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onProtocolError });
    let jobReads = 0;
    const malformed = {};
    Object.defineProperties(malformed, {
      event: { enumerable: true, value: 'completed' },
      job: {
        enumerable: true,
        get() {
          jobReads += 1;
          throw new Error('hostile job getter');
        },
      },
      result: { enumerable: true, value: untransferred },
    });
    TestChannel.latest.emit(malformed);
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('job_cancel', {
      id: initial.id,
    }));

    expect(jobReads).toBe(0);
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: untransferred.playback.id,
    });
  });

  test('releases a buffered completion when the returned start snapshot is malformed', async () => {
    let resolveStart;
    const renderRequest = request();
    const initial = job();
    const completed = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 3 });
      }
      if (command === 'render_playback_release') return Promise.resolve(true);
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(renderRequest, {});
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: completed,
    });
    resolveStart({ ...initial, kind: 'downloadMedia' });

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: completed.playback.id,
    });
  });

  test('releases buffered completion capabilities abandoned by an earlier protocol failure', async () => {
    let resolveStart;
    const renderRequest = request();
    const initial = job({ progress: { basisPoints: 5_000 }, sequence: 2 });
    const completed = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn((command) => {
      if (command === 'render_start') {
        return new Promise((resolve) => { resolveStart = resolve; });
      }
      if (command === 'job_cancel') {
        return Promise.resolve({ ...initial, state: 'cancelling', sequence: 3 });
      }
      if (command === 'render_playback_release') return Promise.resolve(true);
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const starting = service.start(renderRequest, {});
    TestChannel.latest.emit({
      event: 'progress',
      job: { ...initial, progress: { basisPoints: 1_000 }, sequence: 1 },
      phase: 'staging',
      fractionMillionths: 100_000,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: 75,
    });
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 3,
      },
      result: completed,
    });
    resolveStart(initial);

    await expect(starting).rejects.toMatchObject({ code: 'invalidRenderResponse' });
    expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
  });
});
