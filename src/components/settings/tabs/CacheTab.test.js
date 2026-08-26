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

const cacheDetails = (categories = {}) => {
  const details = Object.values(categories);
  const totalCount = details.reduce((sum, category) => sum + category.count, 0);
  const totalSize = details.reduce((sum, category) => sum + category.size, 0);
  return {
    ...categories,
    totalCount,
    totalSize,
    formattedTotalSize: totalSize === 1024 ? '1 KB' : `${totalSize} Bytes`,
  };
};

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
    details: cacheDetails({
      videos: { count: 1, size: 1024, files: [], formattedSize: '1 KB' },
    }),
  });
  clearCache.mockResolvedValue({
    success: true,
    details: { videos: { count: 1, size: 1024, files: [], formattedSize: '1 KB' } },
  });

  render(<CacheTab isActive />);

  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(1));
  fireEvent.click(await screen.findByTitle('Clear Cached Video Data'));
  await waitFor(() => expect(clearCache).toHaveBeenCalledWith('videos'));
  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(2));
  expect(window.fetch).not.toHaveBeenCalled();
});

it('never invalidates the active project media identity when clearing cache data', async () => {
  const videos = { count: 1, size: 1024, files: [], formattedSize: '1 KB' };
  getCacheInfo
    .mockResolvedValueOnce({ success: true, details: cacheDetails({ videos }) })
    .mockResolvedValueOnce({ success: true, details: cacheDetails() });
  clearCache.mockResolvedValue({
    success: true,
    details: {
      videos,
      totalCount: 1,
      totalSize: 1024,
      formattedTotalSize: '1 KB',
    },
  });
  localStorage.setItem('current_video_url', 'https://example.test/watch/source');
  localStorage.setItem('current_file_url', 'http://127.0.0.1:49152/asset/active');
  localStorage.setItem('current_file_cache_id', 'durable-asset-id');
  localStorage.setItem('narration_cache', 'active-narration-state');

  render(<CacheTab isActive />);

  await screen.findByText('Cached Video Data:');
  fireEvent.click(screen.getByRole('button', { name: 'Clear Cache' }));
  await waitFor(() => expect(clearCache).toHaveBeenCalledWith());
  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(2));

  expect(localStorage.getItem('current_video_url'))
    .toBe('https://example.test/watch/source');
  expect(localStorage.getItem('current_file_url'))
    .toBe('http://127.0.0.1:49152/asset/active');
  expect(localStorage.getItem('current_file_cache_id')).toBe('durable-asset-id');
  expect(localStorage.getItem('narration_cache')).toBe('active-narration-state');
});

it('describes cache clearing as rebuildable-only and does not claim source uploads are deleted', async () => {
  getCacheInfo.mockResolvedValue({ success: true, details: cacheDetails() });

  render(<CacheTab isActive />);

  expect(await screen.findByText(/Clear only rebuildable temporary data/)).toBeInTheDocument();
  expect(screen.getByText(/imported source files/)).toBeInTheDocument();
  expect(screen.queryByText(/Clear all cached files including subtitles/)).toBeNull();
});

it('renders and clears only categories reported by the native cache inventory', async () => {
  const waveform = { count: 2, size: 512, files: [], formattedSize: '512 Bytes' };
  getCacheInfo.mockResolvedValue({
    success: true,
    details: cacheDetails({ waveform }),
  });
  clearCache.mockResolvedValue({ success: true, details: { waveform } });

  const { container } = render(<CacheTab isActive />);

  expect(await screen.findByText('Cached Waveforms:')).toBeInTheDocument();
  expect(container.querySelector('[data-cache-category="waveform"]')).not.toBeNull();
  expect(container.querySelector('[data-cache-category="videoRendererUploads"]')).toBeNull();
  expect(container.querySelector('[data-cache-category="videoRendererOutput"]')).toBeNull();

  fireEvent.click(screen.getByTitle('Clear Cached Waveforms'));
  await waitFor(() => expect(clearCache).toHaveBeenCalledWith('waveform'));
});

it('fails closed when native cache inspection is unavailable without probing HTTP', async () => {
  getCacheInfo.mockRejectedValue(new Error('This operation requires the desktop runtime'));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  render(<CacheTab isActive />);

  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(1));
  expect(window.fetch).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

it('does not announce an empty cache just because the tab became active', async () => {
  getCacheInfo.mockResolvedValue({ success: true, details: cacheDetails() });

  render(<CacheTab isActive />);

  await waitFor(() => expect(getCacheInfo).toHaveBeenCalledTimes(1));
  expect(window.addToast).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTitle('Refresh cache information'));
  await waitFor(() => expect(window.addToast).toHaveBeenCalledWith(
    'Cache is empty. No files to clear.',
    'info',
    5000
  ));
});
