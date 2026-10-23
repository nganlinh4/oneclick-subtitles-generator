import {
  captureActiveMediaSource,
  clearActiveMediaSource,
  readActiveMedia,
  restoreActiveMediaSource,
  subscribeActiveMedia,
  updateActiveMedia,
} from './activeMediaSource';

const TOKEN_URL = 'http://127.0.0.1:49152/asset/a?token=private-capability';

beforeEach(() => localStorage.clear());

test('keeps the active media in memory and never in WebView storage', () => {
  updateActiveMedia({ sourceUrl: 'https://example.test/watch', playbackUrl: TOKEN_URL });

  expect(readActiveMedia()).toMatchObject({
    sourceUrl: 'https://example.test/watch',
    playbackUrl: TOKEN_URL,
  });
  expect(JSON.stringify({ ...localStorage })).not.toContain('private-capability');
});

test('notifies subscribers only when a field actually changes', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeActiveMedia(listener);

  updateActiveMedia({ sourceUrl: 'https://example.test/a' });
  updateActiveMedia({ sourceUrl: 'https://example.test/a' });
  expect(listener).toHaveBeenCalledTimes(1);

  unsubscribe();
  updateActiveMedia({ sourceUrl: null });
  expect(listener).toHaveBeenCalledTimes(1);
});

test('clearing withdraws the source but leaves the native session to its own lifecycle', () => {
  const session = Object.freeze({ assetId: 'a', cacheId: 'c', projectId: 'p' });
  updateActiveMedia({ sourceUrl: 'https://example.test/a', playbackUrl: TOKEN_URL, session });

  clearActiveMediaSource();

  expect(readActiveMedia()).toEqual({
    sourceUrl: null,
    playbackUrl: null,
    session,
  });
});

test('restores an exact captured source', () => {
  updateActiveMedia({ sourceUrl: 'https://example.test/a', playbackUrl: TOKEN_URL });
  const snapshot = captureActiveMediaSource();
  updateActiveMedia({ sourceUrl: 'https://example.test/b', playbackUrl: null });

  restoreActiveMediaSource(snapshot);

  expect(readActiveMedia()).toMatchObject({ sourceUrl: 'https://example.test/a', playbackUrl: TOKEN_URL });
});

test('refuses unknown fields and invalid values', () => {
  expect(() => updateActiveMedia({ fileName: 'clip.mp4' })).toThrow(TypeError);
  expect(() => updateActiveMedia({ browserCacheId: 'hash' })).toThrow(TypeError);
  expect(() => updateActiveMedia({ sourceUrl: '' })).toThrow(TypeError);
});
