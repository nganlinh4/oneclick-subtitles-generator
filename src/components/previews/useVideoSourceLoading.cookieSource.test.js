import { renderHook, waitFor } from '@testing-library/react';

import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import useVideoSourceLoading from './useVideoSourceLoading';

vi.mock('../../platform/nativeUrlDownloadAdapter', () => ({
  downloadNativeVideo: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

it.each([
  ['cookies enabled', 'true'],
  ['cookies disabled', 'false'],
])('keeps URL preview loading side-effect-free when %s', async (_label, enabled) => {
  localStorage.setItem('use_cookies_for_download', enabled);
  localStorage.setItem('download_cookie_source', 'edge');

  const { result } = renderHook(() => useVideoSourceLoading({
    videoSource: 'https://www.youtube.com/watch?v=preview',
    t: (_key, fallback) => fallback,
  }));

  await waitFor(() => {
    expect(result.current.error).toBe('Prepare this video before opening its preview.');
  });
  expect(result.current.videoUrl).toBe('');
  expect(result.current.isDownloading).toBe(false);
  expect(downloadNativeVideo).not.toHaveBeenCalled();
});
