// Native render lifecycle: abort-signal registration, cleanup failures and cancellation.

import { createNativeRenderService, runNativeRender } from './renderService';
import {
  TestChannel,
  createTrackedAbortSignal,
  job,
  request,
  result,
} from './renderServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('native render lifecycle: abort signals', () => {
  test('a throwing signal cleanup cannot block completed playback delivery', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const renderRequest = request();
    const completedResult = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    const running = runNativeRender(renderRequest, { signal: tracked.signal }, service);
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
      'render_start',
      expect.any(Object),
    ));
    TestChannel.latest.emit({
      event: 'completed',
      job: {
        ...initial,
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      },
      result: completedResult,
    });

    await expect(running).resolves.toMatchObject({ result: completedResult });
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual(['render_start']);
    expect(tracked.counts).toEqual({
      abortedGets: 2,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });

  test('reentrant signal cleanup cannot revoke the playback transferred by completion', async () => {
    const initial = job();
    const renderRequest = request();
    const completedEvent = {
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
    };
    let reentered = false;
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        if (reentered) return;
        reentered = true;
        TestChannel.latest.emit(completedEvent);
      },
    };
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    let settleDelivery;
    const delivered = new Promise((resolve) => { settleDelivery = resolve; });
    const onCompleted = vi.fn((event) => settleDelivery(event));
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted }, { signal });
    TestChannel.latest.emit(completedEvent);

    await expect(delivered).resolves.toMatchObject({ result: completedEvent.result });
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual(['render_start']);
  });

  test('reentrant signal cleanup releases only a distinct untransferred playback once', async () => {
    const initial = job();
    const renderRequest = request();
    const completedJob = {
      ...initial,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    };
    const accepted = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const untransferred = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    let reentered = false;
    const signal = {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        if (reentered) return;
        reentered = true;
        const duplicate = { event: 'completed', job: completedJob, result: untransferred };
        TestChannel.latest.emit(duplicate);
        TestChannel.latest.emit(duplicate);
      },
    };
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const onCompleted = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(renderRequest, { onCompleted }, { signal });
    TestChannel.latest.emit({ event: 'completed', job: completedJob, result: accepted });
    await Promise.resolve();

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: untransferred.playback.id }]]);
    expect(invokeCommand).not.toHaveBeenCalledWith('render_playback_release', {
      playbackId: accepted.playback.id,
    });
  });

  test('throwing signal cleanup cannot suppress failed terminal delivery', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const onFailed = vi.fn();
    const service = createNativeRenderService({
      invokeCommand: vi.fn(async (command) => {
        if (command === 'render_start') return initial;
        throw new Error(`unexpected command: ${command}`);
      }),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onFailed }, { signal: tracked.signal });
    TestChannel.latest.emit({
      event: 'failed',
      job: { ...initial, state: 'failed', sequence: 2 },
      error: { code: 'internal', message: 'redacted by adapter' },
    });

    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(tracked.counts.removeCalls).toBe(1);
    tracked.abort();
  });

  test('throwing signal cleanup cannot suppress protocol failure or duplicate cancellation', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onProtocolError = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onProtocolError }, { signal: tracked.signal });
    TestChannel.latest.emit({ event: 'invalid' });
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('job_cancel', {
      id: initial.id,
    }));

    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(tracked.counts.removeCalls).toBe(1);
    tracked.abort();
    await Promise.resolve();
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel')).toHaveLength(1);
  });

  test('a throwing signal cleanup still delivers cancellation after admission', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const initial = job();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_start') return initial;
      if (command === 'job_cancel') {
        return { ...initial, state: 'cancelling', sequence: 2 };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const onCancelled = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });
    await service.start(request(), { onCancelled }, { signal: tracked.signal });
    tracked.abort();
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith('job_cancel', {
      id: initial.id,
    }));
    TestChannel.latest.emit({
      event: 'cancelled',
      job: { ...initial, state: 'cancelled', sequence: 3 },
    });

    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(tracked.counts.removeCalls).toBe(1);
  });

  test('contains listener-registration and cleanup failures before native admission', async () => {
    const tracked = createTrackedAbortSignal({ throwOnAdd: true, throwOnRemove: true });
    const invokeCommand = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(runNativeRender(request(), { signal: tracked.signal }, service)).rejects
      .toMatchObject({ code: 'invalidRenderRequest' });
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(tracked.counts).toEqual({
      abortedGets: 1,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });

  test.each(['aborted', 'addEventListener', 'removeEventListener'])(
    'reads a hostile %s getter at most once and never starts native work',
    async (throwingGetter) => {
      const tracked = createTrackedAbortSignal({ throwingGetter });
      const invokeCommand = vi.fn();
      const service = createNativeRenderService({
        invokeCommand,
        ChannelConstructor: TestChannel,
        isNativeRuntime: () => true,
      });

      await expect(runNativeRender(request(), { signal: tracked.signal }, service)).rejects
        .toMatchObject({ code: 'invalidRenderRequest' });
      expect(invokeCommand).not.toHaveBeenCalled();
      expect(tracked.counts.abortedGets).toBeLessThanOrEqual(1);
      expect(tracked.counts.addGets).toBeLessThanOrEqual(1);
      expect(tracked.counts.removeGets).toBeLessThanOrEqual(1);
    },
  );

  test('an abort fired during registration wins before native admission', async () => {
    const tracked = createTrackedAbortSignal({ abortDuringAdd: true });
    const invokeCommand = vi.fn();
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(runNativeRender(request(), { signal: tracked.signal }, service)).rejects
      .toMatchObject({ name: 'AbortError', code: 'renderCancelled' });
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(tracked.counts).toEqual({
      abortedGets: 2,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });
});
