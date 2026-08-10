import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { clearCache, getCacheInfo } from '../../../platform/cacheService';
import CacheTab from './CacheTab';

vi.mock('../../../platform/cacheService', () => ({
  clearCache: vi.fn(),
  getCacheInfo: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback, values = {}) => Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    ),
  }),
}));

const emptyCategory = Object.freeze({ count: 0, size: 0, files: [], formattedSize: '0 Bytes' });

const cacheDetails = (videos = emptyCategory) => ({
  subtitles: emptyCategory,
  videos,
  userSubtitles: emptyCategory,
  rules: emptyCategory,
  narrationReference: emptyCategory,
  narrationOutput: emptyCategory,
  lyrics: emptyCategory,
  albumArt: emptyCategory,
  uploads: emptyCategory,
  output: emptyCategory,
  videoRendered: emptyCategory,
  videoTemp: emptyCategory,
  videoAlbumArt: emptyCategory,
  videoRendererUploads: emptyCategory,
  videoRendererOutput: emptyCategory,
  totalCount: videos.count,
  totalSize: videos.size,
  formattedTotalSize: videos.formattedSize,
});

beforeEach(() => {
  getCacheInfo.mockReset();
  clearCache.mockReset();
  window.addToast = vi.fn();
  window.fetch = vi.fn();
  localStorage.clear();
});

it('uses only the native cache service in the desktop runtime', async () => {
  getCacheInfo.mockResolvedValue({
    success: true,
    details: cacheDetails({ count: 1, size: 1024, files: [], formattedSize: '1 KB' }),
  });
  clearCache.mockResolvedValue({
    success: true,
    details: { videos: { count: 1, size: 1024, files: [], formattedSize: '1 KB' } },
  });

  render(<CacheTab isActive />);

  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByTitle('Clear Videos'));
  await waitFor(() => expect(clearCache).toHaveBeenCalledWith('videos'));
  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(2));
  expect(window.fetch).not.toHaveBeenCalled();
});

it('fails closed when native cache inspection is unavailable without probing HTTP', async () => {
  getCacheInfo.mockRejectedValue(new Error('This operation requires the desktop runtime'));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  render(<CacheTab isActive />);

  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(1));
  expect(window.fetch).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
