import { renderHook, waitFor } from '@testing-library/react';

import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';
import useVideoSourceLoading from './useVideoSourceLoading';

vi.mock('../../platform/nativeUrlDownloadAdapter', () => ({
  downloadNativeVideo: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  downloadNativeVideo.mockResolvedValue({
    playbackUrl: 'http://127.0.0.1/native-preview',
  });
});

it('propagates the selected browser source into preview media loading', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'edge');

  renderHook(() => useVideoSourceLoading({
    videoSource: 'https://www.youtube.com/watch?v=preview',
    t: (_key, fallback) => fallback,
  }));

  await waitFor(() => expect(downloadNativeVideo).toHaveBeenCalledWith(expect.objectContaining({
    url: 'https://www.youtube.com/watch?v=preview',
    cookieSource: 'edge',
  })));
});

it('propagates none into preview loading when cookies are disabled', async () => {
  localStorage.setItem('use_cookies_for_download', 'false');
  localStorage.setItem('download_cookie_source', 'edge');

  renderHook(() => useVideoSourceLoading({
    videoSource: 'https://www.youtube.com/watch?v=disabled-preview',
    t: (_key, fallback) => fallback,
  }));

  await waitFor(() => expect(downloadNativeVideo).toHaveBeenCalledWith(expect.objectContaining({
    cookieSource: 'none',
  })));
});
