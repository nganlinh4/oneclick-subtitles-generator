import { downloadNativeVideo } from '../platform/nativeUrlDownloadAdapter';
import { preloadYouTubeVideo } from './videoPreloader';

vi.mock('../platform/nativeUrlDownloadAdapter', () => ({
  downloadNativeVideo: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  downloadNativeVideo.mockResolvedValue(null);
});

it('propagates the selected browser source into background preload', () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  localStorage.setItem('download_cookie_source', 'firefox');

  preloadYouTubeVideo('https://youtu.be/preload');

  expect(downloadNativeVideo).toHaveBeenCalledWith({
    url: 'https://youtu.be/preload',
    cookieSource: 'firefox',
  });
});
