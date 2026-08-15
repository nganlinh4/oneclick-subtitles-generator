import { act, renderHook, waitFor } from '@testing-library/react';

import {
  createRecoveredRenderQueueItem,
  mergeNativeRenderResult,
  useRenderQueue,
} from './useRenderQueue';

const recoveryMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  discard: vi.fn(),
  forget: vi.fn(),
  list: vi.fn(),
  remember: vi.fn(),
  start: vi.fn(),
}));

const renderServiceMocks = vi.hoisted(() => ({
  releasePlayback: vi.fn(),
  waitForRender: vi.fn(),
}));

vi.mock('../../platform/jobRecoveryCoordinator', () => ({
  claimRecoveredNativeJob: recoveryMocks.claim,
  discardRecoveredNativeJob: recoveryMocks.discard,
  forgetNativeJobId: recoveryMocks.forget,
  listRecoveredNativeJobs: recoveryMocks.list,
  rememberNativeJobId: recoveryMocks.remember,
  startNativeJobRecovery: recoveryMocks.start,
}));

vi.mock('../../platform/renderService', () => ({
  releaseNativeRenderPlayback: renderServiceMocks.releasePlayback,
  waitForNativeRender: renderServiceMocks.waitForRender,
}));

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const jobId = '0198a1d0-3040-7000-8000-000000000001';
const assetId = '0198a1d0-3040-7000-8000-000000000002';
const artifactId = '0198a1d0-3040-7000-8000-000000000003';
const playbackId = '2a279fd7-6168-4f99-a053-fd809b556101';

const succeededJob = {
  id: jobId,
  kind: 'renderVideo',
  state: 'succeeded',
  progress: { basisPoints: 10_000 },
  sequence: 4,
};

const succeededResponse = {
  job: succeededJob,
  result: {
    artifactId,
    asset: {
      id: assetId,
      displayName: 'rendered-video.mp4',
      extension: 'mp4',
      sizeBytes: 1_024,
      kind: 'video',
    },
    playback: {
      id: playbackId,
      playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${'b'.repeat(64)}`,
      mimeType: 'video/mp4',
      byteLength: 1_024,
    },
    width: 1_920,
    height: 1_080,
    fps: 30,
    durationInFrames: 300,
    sourceAssetId: '0198a1d0-3040-7000-8000-000000000004',
    projectId: '0198a1d0-3040-7000-8000-000000000005',
  },
};

const hookProps = () => ({
  setIsRendering: vi.fn(),
  setRenderProgress: vi.fn(),
  setRenderStatus: vi.fn(),
  setRenderedVideoUrl: vi.fn(),
  setError: vi.fn(),
  currentRenderId: null,
  setCurrentRenderId: vi.fn(),
  setAbortController: vi.fn(),
  t: (_key, fallback) => fallback,
  startRenderRef: { current: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  recoveryMocks.start.mockResolvedValue({ recovered: 0, discarded: 0, unavailable: false });
  recoveryMocks.list.mockReturnValue([]);
  renderServiceMocks.releasePlayback.mockResolvedValue(true);
});

describe('native render queue hydration', () => {
  test('rehydrates a succeeded durable job with a fresh scoped playback', () => {
    const queueItem = {
      id: 'render-1',
      nativeJobId: jobId,
      status: 'processing',
      progress: 65,
      startedAt: 1,
    };
    const hydrated = mergeNativeRenderResult(queueItem, succeededResponse);

    expect(hydrated).toMatchObject({
      status: 'completed',
      progress: 100,
      outputAssetId: assetId,
      outputArtifactId: artifactId,
      outputPlaybackId: playbackId,
    });
    expect(hydrated.outputPath).toContain(`/asset/${playbackId}?token=`);
  });

  test('builds an exportable queue row for a recovered completed render', () => {
    const recovered = createRecoveredRenderQueueItem(succeededResponse, () => 123_456);

    expect(recovered).toMatchObject({
      id: `recovered_${jobId}`,
      nativeJobId: jobId,
      status: 'completed',
      timestamp: 123_456,
      settings: { resolution: '1080p', frameRate: 30 },
      outputAssetId: assetId,
      outputArtifactId: artifactId,
      outputPlaybackId: playbackId,
    });
  });

  test('surfaces a claimed recovered render in the queue and releases it on unmount', async () => {
    recoveryMocks.list.mockReturnValue([{ job: succeededJob, value: succeededResponse }]);
    recoveryMocks.claim.mockReturnValue({ job: succeededJob, value: succeededResponse });
    const props = hookProps();
    const view = renderHook(() => useRenderQueue(props));

    await waitFor(() => {
      expect(props.setRenderedVideoUrl).toHaveBeenCalledWith(
        succeededResponse.result.playback.playbackUrl,
      );
      expect(view.result.current.renderQueue).toEqual([
        expect.objectContaining({
          nativeJobId: jobId,
          status: 'completed',
          outputAssetId: assetId,
        }),
      ]);
    });
    view.unmount();

    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledWith(playbackId);
  });

  test('removing a recovered row releases its playback exactly once', async () => {
    recoveryMocks.list.mockReturnValue([{ job: succeededJob, value: succeededResponse }]);
    recoveryMocks.claim.mockReturnValue({ job: succeededJob, value: succeededResponse });
    const view = renderHook(() => useRenderQueue(hookProps()));

    await waitFor(() => expect(view.result.current.renderQueue).toHaveLength(1));
    act(() => view.result.current.removeFromQueue(`recovered_${jobId}`));
    view.unmount();

    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledTimes(1);
    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledWith(playbackId);
  });

  test('keeps a recovered queue row playable while a new render starts', async () => {
    recoveryMocks.list.mockReturnValue([{ job: succeededJob, value: succeededResponse }]);
    recoveryMocks.claim.mockReturnValue({ job: succeededJob, value: succeededResponse });
    const props = hookProps();
    const view = renderHook(
      ({ currentRenderId }) => useRenderQueue({ ...props, currentRenderId }),
      { initialProps: { currentRenderId: null } },
    );

    await waitFor(() => expect(view.result.current.renderQueue).toHaveLength(1));
    view.rerender({ currentRenderId: '0198a1d0-3040-7000-8000-000000000099' });

    expect(renderServiceMocks.releasePlayback).not.toHaveBeenCalled();
    expect(view.result.current.renderQueue[0]).toMatchObject({
      status: 'completed',
      outputPlaybackId: playbackId,
    });

    view.unmount();
    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledTimes(1);
    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledWith(playbackId);
  });

  test('releases every completed queue playback exactly once on unmount', async () => {
    const secondPlaybackId = '2a279fd7-6168-4f99-a053-fd809b556102';
    const view = renderHook(() => useRenderQueue(hookProps()));

    act(() => view.result.current.setRenderQueue([
      { id: 'first', status: 'completed', outputPlaybackId: playbackId },
      { id: 'second', status: 'completed', outputPlaybackId: secondPlaybackId },
    ]));
    await waitFor(() => expect(view.result.current.renderQueue).toHaveLength(2));
    view.unmount();

    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledTimes(2);
    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledWith(playbackId);
    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledWith(secondPlaybackId);
  });

  test('owns a just-completed playback before its queue state can commit', () => {
    const view = renderHook(() => useRenderQueue(hookProps()));

    act(() => view.result.current.ownQueuePlayback(playbackId));
    view.unmount();

    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledTimes(1);
    expect(renderServiceMocks.releasePlayback).toHaveBeenCalledWith(playbackId);
  });

  test('leaves coordinator-owned jobs untouched when startup finishes after unmount', async () => {
    let finishStartup;
    recoveryMocks.start.mockReturnValue(new Promise((resolve) => {
      finishStartup = resolve;
    }));
    recoveryMocks.list.mockReturnValue([{ job: succeededJob, value: succeededResponse }]);
    const view = renderHook(() => useRenderQueue(hookProps()));
    view.unmount();

    await act(async () => {
      finishStartup({ recovered: 1, discarded: 0, unavailable: false });
      await Promise.resolve();
    });

    expect(recoveryMocks.claim).not.toHaveBeenCalled();
    expect(recoveryMocks.discard).not.toHaveBeenCalled();
    expect(renderServiceMocks.releasePlayback).not.toHaveBeenCalled();
  });
});

describe('native render queue lease', () => {
  test('admits one same-tick pump and advances pending work with a new generation', async () => {
    const resolvers = [];
    const owners = [];
    const props = hookProps();
    props.startRenderRef.current = vi.fn((_item, owner) => {
      owners.push(owner);
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const view = renderHook(() => useRenderQueue(props));
    act(() => view.result.current.setRenderQueue([
      { id: 'first', status: 'pending', progress: 0 },
      { id: 'second', status: 'pending', progress: 0 },
    ]));

    let admitted;
    let competing;
    act(() => {
      admitted = view.result.current.startNextPendingRender();
      competing = view.result.current.startNextPendingRender();
    });

    await expect(competing).resolves.toBe(false);
    expect(props.startRenderRef.current).toHaveBeenCalledTimes(1);
    expect(owners[0]).toMatchObject({ queueItemId: 'first', generation: 1 });
    expect(view.result.current.ownsRenderLease(owners[0])).toBe(true);

    await act(async () => {
      resolvers[0]();
      await admitted;
    });
    await waitFor(() => expect(props.startRenderRef.current).toHaveBeenCalledTimes(2));
    expect(owners[1]).toMatchObject({ queueItemId: 'second', generation: 2 });
    expect(view.result.current.ownsRenderLease(owners[0])).toBe(false);
    expect(view.result.current.ownsRenderLease(owners[1])).toBe(true);

    await act(async () => {
      resolvers[1]();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.currentQueueItem).toBeNull());
    expect(props.startRenderRef.current).toHaveBeenCalledTimes(2);
    expect(props.setIsRendering.mock.calls).toEqual([
      [true],
      [false],
      [true],
      [false],
    ]);
  });

  test('contains an unexpected owner failure and pumps the next item exactly once', async () => {
    let resolveSecond;
    const owners = [];
    const props = hookProps();
    props.startRenderRef.current = vi.fn((item, owner) => {
      owners.push(owner);
      if (item.id === 'first') return Promise.reject(new Error('C:\\private\\secret'));
      return new Promise((resolve) => { resolveSecond = resolve; });
    });
    const view = renderHook(() => useRenderQueue(props));
    act(() => view.result.current.setRenderQueue([
      { id: 'first', status: 'pending', progress: 0 },
      { id: 'second', status: 'pending', progress: 0 },
    ]));

    await act(async () => {
      await view.result.current.startNextPendingRender();
    });
    await waitFor(() => expect(props.startRenderRef.current).toHaveBeenCalledTimes(2));
    expect(view.result.current.renderQueue.find((item) => item.id === 'first')).toMatchObject({
      status: 'failed',
      error: 'Render failed',
      renderGeneration: 1,
    });
    expect(JSON.stringify(view.result.current.renderQueue)).not.toContain('private');
    expect(view.result.current.ownsRenderLease(owners[0])).toBe(false);
    expect(view.result.current.ownsRenderLease(owners[1])).toBe(true);

    await act(async () => {
      resolveSecond();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.result.current.currentQueueItem).toBeNull());
    expect(props.startRenderRef.current).toHaveBeenCalledTimes(2);
  });
});
