// resolveCachedRetrySource: native descriptors are reopened, never fetched by the WebView.
import { resolveCachedRetrySource } from './segmentRetrySource';
import { ASSET_ID, PLAYBACK_URL, media } from './useSubtitlesSegmentRetryTestFixtures';

test('reopens the selected opaque native media for cached retry without WebView fetch', async () => {
  const fetchMedia = vi.fn(() => {
    throw new Error('WebView fetch must remain unreachable');
  });
  const selectedMedia = vi.fn(async () => media);

  await expect(resolveCachedRetrySource(null, PLAYBACK_URL, {
    nativeRuntime: () => true,
    selectedMedia,
    fetchMedia,
    expectedAssetId: ASSET_ID,
  })).resolves.toEqual({ sourceFile: media, usesOriginalMedia: true });
  expect(selectedMedia).toHaveBeenCalledTimes(1);
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('replaces a stale browser source with the selected native descriptor', async () => {
  const fetchMedia = vi.fn();
  const selectedMedia = vi.fn(async () => media);

  await expect(resolveCachedRetrySource(new File(['stale'], 'stale.mp4'), PLAYBACK_URL, {
    nativeRuntime: () => true,
    selectedMedia,
    fetchMedia,
    expectedAssetId: ASSET_ID,
  })).resolves.toEqual({ sourceFile: media, usesOriginalMedia: true });
  expect(selectedMedia).toHaveBeenCalledTimes(1);
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('reopens the exact active native asset for a URL project instead of trusting its stale source ref', async () => {
  const stale = Object.freeze({ ...media, assetId: '01890f39-7b62-7c4e-8c9a-000000000999' });
  const selectedMedia = vi.fn(async () => media);

  await expect(resolveCachedRetrySource(stale, PLAYBACK_URL, {
    nativeRuntime: () => true,
    selectedMedia,
    fetchMedia: vi.fn(),
    expectedAssetId: ASSET_ID,
  })).resolves.toEqual({ sourceFile: media, usesOriginalMedia: true });
  expect(selectedMedia).toHaveBeenCalledTimes(1);
});

test('rejects a native capability in browser fallback before any network request', async () => {
  const fetchMedia = vi.fn();
  await expect(resolveCachedRetrySource(null, PLAYBACK_URL, {
    nativeRuntime: () => false,
    fetchMedia,
  })).rejects.toThrow('cannot be fetched');
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('keeps the browser cached-clip fallback and forwards operation cancellation', async () => {
  const blob = new Blob(['clip'], { type: 'video/mp4' });
  const fetchMedia = vi.fn(async () => ({ ok: true, blob: async () => blob }));
  const controller = new AbortController();

  const resolved = await resolveCachedRetrySource(null, 'blob:cached-segment', {
    nativeRuntime: () => false,
    fetchMedia,
    signal: controller.signal,
  });

  expect(fetchMedia).toHaveBeenCalledWith('blob:cached-segment', { signal: controller.signal });
  expect(resolved.usesOriginalMedia).toBe(false);
  expect(resolved.sourceFile).toBeInstanceOf(File);
});
