import { resolveCachedRetrySource } from './useSubtitlesSegmentRetry';

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;
const media = Object.freeze({
  __nativeMedia: true,
  assetId: ASSET_ID,
  playbackId: PLAYBACK_ID,
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4_096,
  lastModified: 0,
  playbackUrl: PLAYBACK_URL,
});

test('reopens the selected opaque native media for cached retry without WebView fetch', async () => {
  const fetchMedia = vi.fn(() => {
    throw new Error('WebView fetch must remain unreachable');
  });
  const selectedMedia = vi.fn(async () => media);

  await expect(resolveCachedRetrySource(null, PLAYBACK_URL, {
    nativeRuntime: () => true,
    selectedMedia,
    fetchMedia,
  })).resolves.toEqual({
    sourceFile: media,
    usesOriginalMedia: true,
  });
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
  })).resolves.toEqual({
    sourceFile: media,
    usesOriginalMedia: true,
  });
  expect(selectedMedia).toHaveBeenCalledTimes(1);
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('rejects a native capability in browser fallback before any network request', async () => {
  const fetchMedia = vi.fn();
  await expect(resolveCachedRetrySource(null, PLAYBACK_URL, {
    nativeRuntime: () => false,
    fetchMedia,
  })).rejects.toThrow('cannot be fetched');
  expect(fetchMedia).not.toHaveBeenCalled();
});

test('keeps the browser cached-clip fallback for ordinary blob URLs', async () => {
  const blob = new Blob(['clip'], { type: 'video/mp4' });
  const fetchMedia = vi.fn(async () => ({
    ok: true,
    blob: async () => blob,
  }));

  const resolved = await resolveCachedRetrySource(null, 'blob:cached-segment', {
    nativeRuntime: () => false,
    fetchMedia,
  });

  expect(fetchMedia).toHaveBeenCalledWith('blob:cached-segment', undefined);
  expect(resolved.usesOriginalMedia).toBe(false);
  expect(resolved.sourceFile).toBeInstanceOf(File);
  expect(resolved.sourceFile.type).toBe('video/mp4');
});
