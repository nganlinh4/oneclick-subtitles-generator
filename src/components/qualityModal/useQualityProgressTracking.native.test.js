import { act, renderHook } from '@testing-library/react';
import {
  cancelDownload,
  inspectDownloadUrl,
  startDownload,
} from '../../platform/downloadService';
import {
  claimMediaCandidate,
  discardMediaCandidate,
} from '../../platform/mediaService';
import { selectNativeQuality } from './useQualityProgressTracking';
import useQualityProgressTracking from './useQualityProgressTracking';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class Channel {},
  invoke: vi.fn(),
}));
vi.mock('../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../platform/downloadService', () => ({
  cancelDownload: vi.fn(),
  inspectDownloadUrl: vi.fn(),
  startDownload: vi.fn(),
}));
vi.mock('../../platform/mediaService', () => ({
  claimMediaCandidate: vi.fn(),
  discardMediaCandidate: vi.fn(),
}));
vi.mock('../../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(async () => 'url-cache'),
}));
vi.mock('../../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: vi.fn(async () => ({
    projectId: '01890f39-7b62-7c4e-8c9a-000000000231',
    snapshot: { stateVersion: 4 },
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

const inventory = {
  formats: {
    video: [
      { formatId: '1080-video', height: 1080, includesAudio: false, bitrateKbps: 4_000 },
      { formatId: '1080-combined', height: 1080, includesAudio: true, bitrateKbps: 2_000 },
      { formatId: '720-combined', height: 720, includesAudio: true, bitrateKbps: 1_000 },
    ],
  },
};

it('prefers an exact combined native download format at the requested height', () => {
  expect(selectNativeQuality(inventory, '1080p')).toEqual({
    mode: 'exact',
    formatId: '1080-combined',
  });
});

it('uses a bounded at-most request when the inventory has no exact format', () => {
  expect(selectNativeQuality(inventory, '480p')).toEqual({ mode: 'atMost', height: 480 });
  expect(() => selectNativeQuality(inventory, 'original')).toThrow(
    'The selected video quality is invalid'
  );
});

it('finishes quality downloads through native channel events without polling localhost', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'opera');
  inspectDownloadUrl.mockResolvedValue({
    capability: { id: '01890f39-7b62-7c4e-8c9a-000000000201' },
    inventory,
  });
  claimMediaCandidate.mockResolvedValue({ native: true, assetId: 'output' });
  discardMediaCandidate.mockResolvedValue(true);
  startDownload.mockImplementation(async (request, handlers) => {
    handlers.onProgress({
      job: { progress: { basisPoints: 2_500 } },
      progress: { fraction: 0.9 },
    });
    handlers.onCompleted({ media: { asset: { id: 'output' } } });
    return { id: '01890f39-7b62-7c4e-8c9a-000000000202' };
  });
  const setDownloadProgress = vi.fn();
  const setIsRedownloading = vi.fn();
  const onConfirm = vi.fn();
  const handleClose = vi.fn();
  const progressIntervalRef = { current: null };
  const { result } = renderHook(() => useQualityProgressTracking({
    progressIntervalRef,
    qualityVideoId: 'legacy-id',
    setIsRedownloading,
    setDownloadProgress,
    onConfirm,
    handleClose,
  }));

  let outcome;
  await act(async () => {
    outcome = await result.current.startQualityDownloadWithId(
      '1080p',
      'https://example.com/video',
      'legacy-id'
    );
  });

  expect(startDownload).toHaveBeenCalledWith(expect.objectContaining({
    inventoryId: '01890f39-7b62-7c4e-8c9a-000000000201',
    media: {
      kind: 'video',
      quality: { mode: 'exact', formatId: '1080-combined' },
    },
  }), expect.any(Object));
  expect(inspectDownloadUrl).toHaveBeenCalledWith({
    url: 'https://example.com/video',
    cookieSource: 'opera',
  });
  expect(setDownloadProgress).toHaveBeenCalledWith(25);
  expect(setDownloadProgress).toHaveBeenCalledWith(100);
  expect(onConfirm).toHaveBeenCalledWith('redownload', expect.objectContaining({
    nativeMedia: { native: true, assetId: 'output' },
  }));
  expect(handleClose).toHaveBeenCalledTimes(1);
  expect(outcome).toEqual({
    success: true,
    nativeMedia: { native: true, assetId: 'output' },
  });
});

it('rejects a pre-registration protocol failure once without cancelling above the service', async () => {
  inspectDownloadUrl.mockResolvedValue({
    capability: { id: '01890f39-7b62-7c4e-8c9a-000000000211' },
    inventory,
  });
  const protocol = Object.assign(new Error('fixed protocol failure'), {
    code: 'invalidDownloadResponse',
  });
  startDownload.mockImplementation(async (_request, handlers) => {
    handlers.onProtocolError(protocol);
    throw protocol;
  });
  const { result } = renderHook(() => useQualityProgressTracking({
    setIsRedownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    onConfirm: vi.fn(),
    handleClose: vi.fn(),
  }));

  await expect(act(async () => result.current.startQualityDownloadWithId(
    '1080p',
    'https://example.com/protocol',
    'legacy-id'
  ))).rejects.toBe(protocol);
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  expect(cancelDownload).not.toHaveBeenCalled();
});

it('keeps an atomic candidate claim authoritative when cancellation arrives after commit begins', async () => {
  inspectDownloadUrl.mockResolvedValue({
    capability: { id: '01890f39-7b62-7c4e-8c9a-000000000221' },
    inventory,
  });
  let resolveOpen;
  claimMediaCandidate.mockReturnValue(new Promise((resolve) => { resolveOpen = resolve; }));
  discardMediaCandidate.mockResolvedValue(true);
  startDownload.mockImplementation(async (_request, handlers) => {
    handlers.onCompleted({ media: { asset: { id: 'output' } } });
    return { id: '01890f39-7b62-7c4e-8c9a-000000000222' };
  });
  cancelDownload.mockResolvedValue({ state: 'cancelling' });
  const onConfirm = vi.fn();
  const handleClose = vi.fn();
  const { result } = renderHook(() => useQualityProgressTracking({
    setIsRedownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    onConfirm,
    handleClose,
  }));

  let operation;
  act(() => {
    operation = result.current.startQualityDownloadWithId(
      '1080p',
      'https://example.com/cancelled-open',
      'legacy-id'
    );
  });
  await vi.waitFor(() => expect(claimMediaCandidate).toHaveBeenCalledWith(
    { asset: { id: 'output' } },
    {
      expectedStateVersion: 4,
      projectId: '01890f39-7b62-7c4e-8c9a-000000000231',
    }
  ));
  await act(async () => result.current.handleCancelRedownload());
  resolveOpen({ native: true, assetId: 'output' });

  let outcome;
  await act(async () => { outcome = await operation; });
  expect(outcome).toEqual({
    success: true,
    nativeMedia: { native: true, assetId: 'output' },
  });
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith('redownload', {
    quality: '1080p',
    url: 'https://example.com/cancelled-open',
    videoId: 'legacy-id',
    nativeMedia: { native: true, assetId: 'output' },
  });
  expect(handleClose).toHaveBeenCalledOnce();
});

it('discards a quality candidate exactly once when project activation fails', async () => {
  inspectDownloadUrl.mockResolvedValue({
    capability: { id: '01890f39-7b62-7c4e-8c9a-000000000241' },
    inventory,
  });
  const activationError = new Error('project version changed');
  claimMediaCandidate.mockRejectedValue(activationError);
  discardMediaCandidate.mockResolvedValue(true);
  startDownload.mockImplementation(async (_request, handlers) => {
    handlers.onCompleted({ media: { asset: { id: 'candidate-output' } } });
    return { id: '01890f39-7b62-7c4e-8c9a-000000000242' };
  });
  const { result } = renderHook(() => useQualityProgressTracking({
    setIsRedownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    onConfirm: vi.fn(),
    handleClose: vi.fn(),
  }));

  await expect(result.current.startQualityDownloadWithId(
    '1080p',
    'https://example.com/failed-activation',
    'legacy-id'
  )).rejects.toBe(activationError);
  expect(discardMediaCandidate).toHaveBeenCalledExactlyOnceWith('candidate-output');
});
