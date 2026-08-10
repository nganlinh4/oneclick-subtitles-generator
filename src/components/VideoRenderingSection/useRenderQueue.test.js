import { act, renderHook, waitFor } from '@testing-library/react';

import { mergeNativeRenderResult, useRenderQueue } from './useRenderQueue';

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
  },
};

const hookProps = () => ({
  isRendering: false,
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

  test('releases a claimed recovered playback capability when its consumer unmounts', async () => {
    recoveryMocks.list.mockReturnValue([{ job: succeededJob, value: succeededResponse }]);
    recoveryMocks.claim.mockReturnValue({ job: succeededJob, value: succeededResponse });
    const props = hookProps();
    const view = renderHook(() => useRenderQueue(props));

    await waitFor(() => {
      expect(props.setRenderedVideoUrl).toHaveBeenCalledWith(
        succeededResponse.result.playback.playbackUrl,
      );
    });
    view.unmount();

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
