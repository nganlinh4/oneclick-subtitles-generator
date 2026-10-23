// Native render lifecycle: result responses, recovered results and polling.

import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

import { createNativeRenderService, runNativeRender, waitForNativeRender } from './renderService';
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

describe('native render lifecycle: results and polling', () => {
  test('releases an exact-job playback capability from a malformed result response', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') {
        return { job: requestedJob, result: completed, unexpectedPath: 'C:\\private\\render.mp4' };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
  });

  test('releases valid result capabilities with invalid or mismatched job envelopes', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    for (const responseJob of [
      { ...requestedJob, id: 'invalid-job-id' },
      { ...requestedJob, id: uuidv7() },
    ]) {
      const completed = result();
      const invokeCommand = vi.fn(async (command) => {
        if (command === 'render_result') return { job: responseJob, result: completed };
        if (command === 'render_playback_release') return true;
        throw new Error(`unexpected command: ${command}`);
      });
      const service = createNativeRenderService({
        invokeCommand,
        ChannelConstructor: TestChannel,
        isNativeRuntime: () => true,
      });

      await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
        code: 'invalidRenderResponse',
      });
      expect(invokeCommand.mock.calls.filter(
        ([command]) => command === 'render_playback_release'
      )).toEqual([['render_playback_release', { playbackId: completed.playback.id }]]);
    }
  });

  test('salvages result playback without executing a hostile job accessor', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    let jobReads = 0;
    const malformed = {};
    Object.defineProperties(malformed, {
      job: {
        enumerable: true,
        get() {
          jobReads += 1;
          throw new Error('hostile result job getter');
        },
      },
      result: { enumerable: true, value: completed },
    });
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') return malformed;
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(jobReads).toBe(0);
    expect(invokeCommand).toHaveBeenCalledWith('render_playback_release', {
      playbackId: completed.playback.id,
    });
  });

  test('a result cleanup failure preserves the original protocol rejection', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') {
        return { job: { ...requestedJob, id: 'invalid-job-id' }, result: completed };
      }
      if (command === 'render_playback_release') {
        throw new Error('C:\\private\\cleanup-secret');
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
      message: 'The desktop host returned invalid native render data',
    });
    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
      message: 'The desktop host returned invalid native render data',
    });
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual([
      'render_result',
      'render_playback_release',
      'render_result',
    ]);
  });

  test('never revokes a result playback that was already transferred to its caller', async () => {
    const requestedJob = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const completed = result();
    let resultCalls = 0;
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'render_result') {
        resultCalls += 1;
        return resultCalls === 1
          ? { job: requestedJob, result: completed }
          : { job: { ...requestedJob, id: 'invalid-job-id' }, result: completed };
      }
      if (command === 'render_playback_release') return true;
      throw new Error(`unexpected command: ${command}`);
    });
    const service = createNativeRenderService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getResult(requestedJob.id)).resolves.toMatchObject({ result: completed });
    await expect(service.getResult(requestedJob.id)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(invokeCommand.mock.calls.filter(
      ([command]) => command === 'render_playback_release'
    )).toHaveLength(0);
  });

  test('rejects and releases a recovered result owned by another render request', async () => {
    const renderRequest = request();
    const succeeded = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const foreign = result({
      sourceAssetId: uuidv7(),
      projectId: renderRequest.projectId,
    });
    const service = {
      start: vi.fn(async (_request, handlers) => {
        handlers.onFailed({
          event: 'failed',
          job: succeeded,
          error: { code: 'mediaServer', message: 'ignored' },
        });
        return job();
      }),
      getResult: vi.fn(async () => ({ job: succeeded, result: foreign })),
      releasePlayback: vi.fn(async () => true),
    };

    await expect(runNativeRender(renderRequest, {}, service)).rejects.toMatchObject({
      code: 'invalidRenderResponse',
    });
    expect(service.releasePlayback).toHaveBeenCalledWith(foreign.playback.id);
  });

  test('aborting recovered-result acquisition releases the capability even when cleanup fails', async () => {
    let resolveResult;
    const controller = new AbortController();
    const renderRequest = request();
    const succeeded = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const recovered = result({
      sourceAssetId: renderRequest.sourceAssetId,
      projectId: renderRequest.projectId,
    });
    const service = {
      start: vi.fn(async (_request, handlers) => {
        handlers.onFailed({
          event: 'failed',
          job: succeeded,
          error: { code: 'mediaServer', message: 'ignored' },
        });
        return job();
      }),
      getResult: vi.fn(() => new Promise((resolve) => { resolveResult = resolve; })),
      releasePlayback: vi.fn(async () => { throw new Error('already closed'); }),
    };
    const running = runNativeRender(renderRequest, { signal: controller.signal }, service);
    await vi.waitFor(() => expect(service.getResult).toHaveBeenCalledTimes(1));
    controller.abort();
    resolveResult({ job: succeeded, result: recovered });

    await expect(running).rejects.toMatchObject({
      name: 'AbortError',
      code: 'renderCancelled',
    });
    expect(service.releasePlayback).toHaveBeenCalledTimes(1);
    expect(service.releasePlayback).toHaveBeenCalledWith(recovered.playback.id);
  });

  test('an abort observed before succeeded-job recovery never registers a result', async () => {
    const controller = new AbortController();
    const succeeded = job({
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    });
    const service = {
      start: vi.fn(async (_request, handlers) => {
        controller.abort();
        handlers.onFailed({
          event: 'failed',
          job: succeeded,
          error: { code: 'mediaServer', message: 'ignored' },
        });
        return job();
      }),
      getResult: vi.fn(),
      releasePlayback: vi.fn(),
    };

    await expect(runNativeRender(request(), { signal: controller.signal }, service)).rejects
      .toMatchObject({ name: 'AbortError', code: 'renderCancelled' });
    expect(service.getResult).not.toHaveBeenCalled();
    expect(service.releasePlayback).not.toHaveBeenCalled();
  });

  test('redacts status and playback-release invocation failures', async () => {
    const secret = { code: 'attackerChosen', message: 'C:\\private\\secret' };
    const service = createNativeRenderService({
      invokeCommand: vi.fn().mockRejectedValue(secret),
      ChannelConstructor: TestChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.status()).rejects.toMatchObject({
      code: 'nativeRenderFailed',
      message: 'The native video render could not be completed',
    });
    await expect(service.releasePlayback(uuidv4())).rejects.toMatchObject({
      code: 'nativeRenderFailed',
      message: 'The native video render could not be completed',
    });
  });

  test('does not publish a polled result after its owner aborts', async () => {
    let resolveResult;
    const controller = new AbortController();
    const onUpdate = vi.fn();
    const service = {
      getResult: vi.fn(() => new Promise((resolve) => { resolveResult = resolve; })),
      releasePlayback: vi.fn(async () => true),
    };
    const pending = waitForNativeRender(uuidv7(), {
      signal: controller.signal,
      onUpdate,
    }, service);
    controller.abort();
    const unreported = result();
    resolveResult({
      job: job({
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      }),
      result: unreported,
    });

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'renderCancelled',
    });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(service.releasePlayback).toHaveBeenCalledWith(unreported.playback.id);
  });

  test('a polled result survives a throwing signal cleanup with bounded getter reads', async () => {
    const tracked = createTrackedAbortSignal({ throwOnRemove: true });
    const response = {
      job: job({
        state: 'succeeded',
        progress: { basisPoints: 10_000 },
        sequence: 2,
      }),
      result: result(),
    };
    const service = {
      getResult: vi.fn(async () => response),
      releasePlayback: vi.fn(),
    };

    await expect(waitForNativeRender(response.job.id, {
      signal: tracked.signal,
      onUpdate: vi.fn(),
    }, service)).resolves.toBe(response);
    expect(tracked.counts).toEqual({
      abortedGets: 2,
      addGets: 1,
      removeGets: 1,
      addCalls: 1,
      removeCalls: 1,
    });
  });
});

/**
 * The refusal vocabulary is a contract with Rust, and nothing was checking it.
 *
 * `apps/desktop/src-tauri/src/render/refusal.rs` is the only place a render refusal is minted. When
 * it gained three codes for atlas paging, this side did not, and `allowedRenderCode` quietly mapped
 * all three to `nativeRenderFailed` — the generic "could not be completed" sentence. Auditing that
 * turned up five OLDER codes in the same state, and they are the ones a user most needs: a full
 * disk, a lost graphics device, an unreadable source, unusable audio, a scene the compositor
 * refuses. Rust knew exactly what went wrong and the editor said nothing.
 *
 * So the vocabulary is read from the Rust source rather than transcribed. A code added there and not
 * here fails this, which is the only way the two stay in step — a list two files apart drifts by
 * default, and it did.
 */
