import { act, renderHook } from '@testing-library/react';
import {
  inspectDownloadUrl,
  startDownload,
} from '../../platform/downloadService';
import { openMediaAsset } from '../../platform/mediaService';
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
vi.mock('../../platform/mediaService', () => ({ openMediaAsset: vi.fn() }));

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
  inspectDownloadUrl.mockResolvedValue({
    capability: { id: '01890f39-7b62-7c4e-8c9a-000000000201' },
    inventory,
  });
  openMediaAsset.mockResolvedValue({ native: true, assetId: 'output' });
  startDownload.mockImplementation(async (request, handlers) => {
    handlers.onProgress({
      job: { progress: { basisPoints: 2_500 } },
      progress: { fraction: 0.5 },
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
  expect(setDownloadProgress).toHaveBeenCalledWith(50);
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
