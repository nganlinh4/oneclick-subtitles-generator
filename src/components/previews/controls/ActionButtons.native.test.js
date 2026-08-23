import { downloadPreviewMedia } from './ActionButtons';
import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../../../platform/activeNativeMedia';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { exportMediaAsset } from '../../../platform/mediaExportService';

vi.mock('../../../platform/activeNativeMedia', () => ({
  resolveActiveNativeMedia: vi.fn(),
  revalidateActiveNativeMedia: vi.fn(),
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
    resolveActiveNativeMedia.mockReset();
    revalidateActiveNativeMedia.mockReset();
    exportMediaAsset.mockReset();
  });

  test('exports the opaque native asset instead of downloading its playback URL', async () => {
    const capability = Object.freeze({
      assetId: '01890f39-7b62-7c4e-8c9a-000000000111',
      projectId: 'project',
    });
    resolveActiveNativeMedia.mockResolvedValueOnce(capability);
    exportMediaAsset.mockResolvedValue({ status: 'completed' });
    revalidateActiveNativeMedia.mockResolvedValue(capability);

    await expect(downloadPreviewMedia({
      videoSource: { assetId: 'opaque', playbackUrl: 'private' },
      currentSource: 'http://127.0.0.1:49152/asset/private',
    })).resolves.toEqual({ status: 'completed' });

    expect(exportMediaAsset).toHaveBeenCalledWith('01890f39-7b62-7c4e-8c9a-000000000111');
    expect(revalidateActiveNativeMedia).toHaveBeenCalledWith(capability);
    expect(document.querySelector('a')).toBeNull();
  });

  test('fails closed when the preview no longer maps to an active native asset', async () => {
    resolveActiveNativeMedia.mockRejectedValue(new Error('unavailable'));
    await expect(downloadPreviewMedia({
      videoSource: 'blob:stale',
      currentSource: 'blob:stale',
    })).rejects.toThrow(/Select the media again/i);
    expect(exportMediaAsset).not.toHaveBeenCalled();
  });
});
