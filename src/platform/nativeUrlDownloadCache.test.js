import { createCompletedAssetCache } from './nativeUrlDownloadCache';

const subtitle = (content) => ({ filename: 'captions.srt', language: 'en', content });

it('remembers, replays and forgets a completed capability', () => {
  const cache = createCompletedAssetCache();
  expect(cache.read('k')).toBeUndefined();

  cache.remember('k', 'asset-1', null);
  expect(cache.read('k')).toEqual(expect.objectContaining({ assetId: 'asset-1', subtitle: null }));
  expect(Object.isFrozen(cache.read('k'))).toBe(true);

  cache.forget('k');
  expect(cache.read('k')).toBeUndefined();
  expect(() => cache.forget('k')).not.toThrow();
});

it('replaces an entry for the same key without double-counting its bytes', () => {
  const cache = createCompletedAssetCache();
  cache.remember('k', 'asset-1', subtitle('a'.repeat(1_000)));
  cache.remember('k', 'asset-2', null);
  expect(cache.read('k')).toEqual(expect.objectContaining({ assetId: 'asset-2' }));

  // Byte accounting stayed consistent, so the bound below is still reachable.
  for (let index = 0; index < 31; index += 1) cache.remember(`extra-${index}`, `a-${index}`, null);
  expect(cache.read('k')).toEqual(expect.objectContaining({ assetId: 'asset-2' }));
});

it('evicts the least recently used entry beyond the bounded count', () => {
  const cache = createCompletedAssetCache();
  for (let index = 0; index < 32; index += 1) cache.remember(`k${index}`, `a${index}`, null);
  // Reuse the oldest so recency, not insertion order, decides the victim.
  expect(cache.read('k0')).toEqual(expect.objectContaining({ assetId: 'a0' }));

  cache.remember('k32', 'a32', null);
  expect(cache.read('k1')).toBeUndefined();
  expect(cache.read('k0')).toEqual(expect.objectContaining({ assetId: 'a0' }));
  expect(cache.read('k32')).toEqual(expect.objectContaining({ assetId: 'a32' }));
});

it('never stores a single capability larger than the whole budget', () => {
  const cache = createCompletedAssetCache();
  cache.remember('k', 'asset-1', subtitle('a'.repeat(17 * 1024 * 1024)));
  expect(cache.read('k')).toBeUndefined();
});

it('evicts older entries when accounted bytes exceed the budget', () => {
  const cache = createCompletedAssetCache();
  const large = subtitle('a'.repeat(6 * 1024 * 1024));
  cache.remember('k0', 'a0', large);
  cache.remember('k1', 'a1', large);
  expect(cache.read('k0')).toEqual(expect.objectContaining({ assetId: 'a0' }));

  cache.remember('k2', 'a2', large);
  expect(cache.read('k1')).toBeUndefined();
  expect(cache.read('k2')).toEqual(expect.objectContaining({ assetId: 'a2' }));
});

it.each([
  ['a throwing subtitle proxy', () => new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('hostile subtitle'); },
    ownKeys() { throw new Error('hostile subtitle'); },
  })],
])('refuses to cache %s', (_label, build) => {
  const cache = createCompletedAssetCache();
  cache.remember('k', 'asset-1', build());
  expect(cache.read('k')).toBeUndefined();
});

it('charges nothing for non-string subtitle fields instead of trusting them', () => {
  const cache = createCompletedAssetCache();
  cache.remember('k', 'asset-1', { filename: 7, language: null, content: undefined });
  expect(cache.read('k')).toEqual(expect.objectContaining({ assetId: 'asset-1' }));
});

it('accounts keys, IDs and subtitles by exact UTF-8 length', () => {
  const cache = createCompletedAssetCache();
  // One ASCII byte, two for U+00E9, three for U+20AC, four for an astral pair.
  const key = `aé€\u{1F600}`;
  cache.remember(key, 'id', subtitle('\u{1F600}'));
  expect(cache.read(key).cacheBytes).toBe(10 + 2 + (12 + 2 + 4));
});

it('rejects a capability whose key alone exceeds the budget', () => {
  const cache = createCompletedAssetCache();
  const key = '\u{1F600}'.repeat(4 * 1024 * 1024 + 1);
  cache.remember(key, 'asset-1', null);
  expect(cache.read(key)).toBeUndefined();
});
