import { downloadPreviewMedia } from './ActionButtons';
import { resolveActiveNativeMediaAssetId } from '../../../platform/activeNativeMedia';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { exportMediaAsset } from '../../../platform/mediaExportService';

vi.mock('../../../platform/activeNativeMedia', () => ({
  resolveActiveNativeMediaAssetId: vi.fn(),
}));
vi.mock('../../../platform/desktopRuntime', () => ({
  isDesktopRuntime: vi.fn(),
}));
vi.mock('../../../platform/mediaExportService', () => ({
  exportMediaAsset: vi.fn(),
}));

describe('preview media download', () => {
  beforeEach(() => {
    isDesktopRuntime.mockReturnValue(true);
    resolveActiveNativeMediaAssetId.mockReset();
    exportMediaAsset.mockReset();
  });

  test('exports the opaque native asset instead of downloading its playback URL', async () => {
    resolveActiveNativeMediaAssetId.mockReturnValueOnce('01890f39-7b62-7c4e-8c9a-000000000111');
    exportMediaAsset.mockResolvedValue({ status: 'completed' });

    await expect(downloadPreviewMedia({
      videoSource: { assetId: 'opaque', playbackUrl: 'private' },
      currentSource: 'http://127.0.0.1:49152/asset/private',
    })).resolves.toEqual({ status: 'completed' });

    expect(exportMediaAsset).toHaveBeenCalledWith('01890f39-7b62-7c4e-8c9a-000000000111');
    expect(document.querySelector('a')).toBeNull();
  });

  test('fails closed when the preview no longer maps to an active native asset', async () => {
    resolveActiveNativeMediaAssetId.mockReturnValue(null);
    await expect(downloadPreviewMedia({
      videoSource: 'blob:stale',
      currentSource: 'blob:stale',
    })).rejects.toThrow(/Select the media again/i);
    expect(exportMediaAsset).not.toHaveBeenCalled();
  });
});
