import {
  getVideoDetails,
  isOAuthEnabled,
  searchYouTubeVideos,
} from './desktopYoutubeService';
import {
  getYouTubeVideoDetailsNative,
  searchYouTubeNative,
} from './providerService';

vi.mock('./providerService', () => ({
  getYouTubeVideoDetailsNative: vi.fn(),
  searchYouTubeNative: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

it('routes YouTube access only through native commands without WebView secrets or transport', async () => {
  searchYouTubeNative.mockResolvedValue([{ id: 'AbCdEfGhI_1' }]);
  getYouTubeVideoDetailsNative.mockResolvedValue({ id: 'AbCdEfGhI_1' });

  const fetchBefore = globalThis.fetch;
  const openBefore = window.open;
  globalThis.fetch = vi.fn(() => {
    throw new Error('WebView provider fetch must not run');
  });
  window.open = vi.fn(() => {
    throw new Error('WebView provider popup must not open');
  });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
    if (key === 'use_youtube_oauth') return 'true';
    throw new Error(`secret storage read attempted: ${key}`);
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('secret storage write attempted');
  });
  const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('secret storage removal attempted');
  });

  try {
    expect(isOAuthEnabled()).toBe(true);
    await expect(searchYouTubeVideos('music', 7)).resolves.toEqual([{ id: 'AbCdEfGhI_1' }]);
    await expect(getVideoDetails('AbCdEfGhI_1')).resolves.toEqual({ id: 'AbCdEfGhI_1' });

    expect(searchYouTubeNative).toHaveBeenCalledWith({
      query: 'music',
      maxResults: 7,
      useOAuth: true,
    });
    expect(getYouTubeVideoDetailsNative).toHaveBeenCalledWith({
      videoId: 'AbCdEfGhI_1',
      useOAuth: true,
    });
    expect(new Set(getItem.mock.calls.map(([key]) => key))).toEqual(new Set(['use_youtube_oauth']));
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  } finally {
    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
    globalThis.fetch = fetchBefore;
    window.open = openBefore;
  }
});
