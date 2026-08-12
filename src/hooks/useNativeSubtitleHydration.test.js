import { beforeEach } from 'vitest';

import {
  createNativeSubtitleHydrator,
  hasExplicitSrtFirstProvenance,
} from './useNativeSubtitleHydration';

const rows = (text) => [{ id: 1, start: 0, end: 1, text }];
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const explicitSrtInfo = Object.freeze({
  hasUploaded: true,
  fileName: 'fixture.srt',
  source: 'srt',
});

beforeEach(() => localStorage.clear());

it('applies only rows for the still-active native cache and unchanged timeline', async () => {
  let activeCacheId = 'asset-a';
  let revision = 3;
  const first = deferred();
  const second = deferred();
  const apply = vi.fn();
  const load = vi.fn((cacheId) => (
    cacheId === 'asset-a' ? first.promise : second.promise
  ));
  const hydrator = createNativeSubtitleHydrator({
    load,
    readCurrentCacheId: () => activeCacheId,
    readRevision: () => revision,
    apply,
  });

  const staleRequest = hydrator.activate('asset-a');
  activeCacheId = 'asset-b';
  const currentRequest = hydrator.activate('asset-b');
  first.resolve(rows('stale'));
  await expect(staleRequest).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();

  revision += 1;
  second.resolve(rows('would overwrite a newer edit'));
  await expect(currentRequest).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();

  load.mockResolvedValueOnce(rows('authoritative'));
  const fresh = hydrator.activate('asset-b');
  await expect(fresh).resolves.toBe(true);
  expect(apply).toHaveBeenCalledExactlyOnceWith(rows('authoritative'));
});

it('preserves SRT-first rows when the first media association has no native track', async () => {
  localStorage.setItem('uploaded_srt_info', JSON.stringify(explicitSrtInfo));
  const apply = vi.fn();
  const hydrator = createNativeSubtitleHydrator({
    load: async () => null,
    readCurrentCacheId: () => 'asset-b',
    readRevision: () => 0,
    apply,
  });

  await expect(hydrator.activate('asset-b', { previousCacheId: null })).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('does not treat an initial reload hydration as a new SRT-first association', async () => {
  localStorage.setItem('uploaded_srt_info', JSON.stringify(explicitSrtInfo));
  const apply = vi.fn();
  const hydrator = createNativeSubtitleHydrator({
    load: async () => null,
    readCurrentCacheId: () => 'asset-a',
    readRevision: () => 0,
    apply,
  });

  await expect(hydrator.activate('asset-a', { previousCacheId: 'asset-a' })).resolves.toBe(true);
  expect(apply).toHaveBeenCalledExactlyOnceWith(null);
});

it('clears media A rows when media B has no native track, even with stale SRT provenance', async () => {
  localStorage.setItem('uploaded_srt_info', JSON.stringify(explicitSrtInfo));
  const apply = vi.fn();
  const hydrator = createNativeSubtitleHydrator({
    load: async () => null,
    readCurrentCacheId: () => 'asset-b',
    readRevision: () => 0,
    apply,
  });

  await expect(hydrator.activate('asset-b', { previousCacheId: 'asset-a' })).resolves.toBe(true);
  expect(apply).toHaveBeenCalledExactlyOnceWith(null);
});

it('clears media A synchronously before awaiting media B rows', async () => {
  const pending = deferred();
  const apply = vi.fn();
  let revision = 0;
  const hydrator = createNativeSubtitleHydrator({
    load: () => pending.promise,
    readCurrentCacheId: () => 'asset-b',
    readRevision: () => revision,
    apply: (value) => {
      revision += 1;
      apply(value);
    },
  });

  const hydration = hydrator.activate('asset-b', { previousCacheId: 'asset-a' });
  expect(apply).toHaveBeenCalledExactlyOnceWith(null);
  pending.resolve(rows('media B'));
  await expect(hydration).resolves.toBe(true);
  expect(apply).toHaveBeenNthCalledWith(2, rows('media B'));
});

it('requires exact, safe uploaded-SRT provenance for a first association', () => {
  const storage = {
    getItem: vi.fn(() => JSON.stringify(explicitSrtInfo)),
  };
  expect(hasExplicitSrtFirstProvenance({ previousCacheId: null, storage })).toBe(true);
  expect(hasExplicitSrtFirstProvenance({ previousCacheId: 'asset-a', storage })).toBe(false);

  storage.getItem.mockReturnValueOnce(JSON.stringify({ ...explicitSrtInfo, trusted: true }));
  expect(hasExplicitSrtFirstProvenance({ previousCacheId: null, storage })).toBe(false);
  storage.getItem.mockReturnValueOnce(JSON.stringify({
    ...explicitSrtInfo,
    fileName: '..\\private.srt',
  }));
  expect(hasExplicitSrtFirstProvenance({ previousCacheId: null, storage })).toBe(false);
  storage.getItem.mockReturnValueOnce('{invalid');
  expect(hasExplicitSrtFirstProvenance({ previousCacheId: null, storage })).toBe(false);
});

it('does not apply a malformed result, failure, or disposed request', async () => {
  const apply = vi.fn();
  let activeCacheId = 'asset';
  let revision = 0;
  const load = vi.fn()
    .mockResolvedValueOnce({ rows: [] })
    .mockRejectedValueOnce(new Error('private project path'))
    .mockResolvedValueOnce(rows('too late'));
  const hydrator = createNativeSubtitleHydrator({
    load,
    readCurrentCacheId: () => activeCacheId,
    readRevision: () => revision,
    apply,
  });

  await expect(hydrator.activate(activeCacheId)).resolves.toBe(false);
  await expect(hydrator.activate(activeCacheId)).resolves.toBe(false);
  const disposed = hydrator.activate(activeCacheId);
  hydrator.dispose();
  await expect(disposed).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();

  activeCacheId = '';
  revision += 1;
  await expect(hydrator.activate(activeCacheId)).resolves.toBe(false);
});

it('clears on a cache miss when the provenance reader throws', async () => {
  const apply = vi.fn();
  const hydrator = createNativeSubtitleHydrator({
    load: async () => null,
    readCurrentCacheId: () => 'asset-b',
    readRevision: () => 0,
    apply,
    preserveOnMiss: () => { throw new Error('private storage detail'); },
  });

  await expect(hydrator.activate('asset-b', { previousCacheId: null })).resolves.toBe(true);
  expect(apply).toHaveBeenCalledExactlyOnceWith(null);
});

it.each([
  ['a rejected load', async () => { throw new Error('private project path'); }],
  ['a malformed load', async () => ({ rows: [] })],
])('clears media A rows when media B returns %s', async (_label, load) => {
  const apply = vi.fn();
  const hydrator = createNativeSubtitleHydrator({
    load,
    readCurrentCacheId: () => 'asset-b',
    readRevision: () => 0,
    apply,
  });

  await expect(hydrator.activate('asset-b', { previousCacheId: 'asset-a' }))
    .resolves.toBe(true);
  expect(apply).toHaveBeenCalledExactlyOnceWith(null);
});

it('does not clear a current timeline for a failed same-media reload', async () => {
  const apply = vi.fn();
  const hydrator = createNativeSubtitleHydrator({
    load: async () => { throw new Error('private project path'); },
    readCurrentCacheId: () => 'asset-a',
    readRevision: () => 0,
    apply,
  });

  await expect(hydrator.activate('asset-a', { previousCacheId: 'asset-a' }))
    .resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('ignores a rejected old-media request after the new media has hydrated', async () => {
  const oldMedia = deferred();
  const apply = vi.fn();
  let activeCacheId = 'asset-a';
  const hydrator = createNativeSubtitleHydrator({
    load: (cacheId) => (
      cacheId === 'asset-a' ? oldMedia.promise : Promise.resolve(rows('media B'))
    ),
    readCurrentCacheId: () => activeCacheId,
    readRevision: () => 0,
    apply,
  });

  const stale = hydrator.activate('asset-a', { previousCacheId: 'asset-a' });
  activeCacheId = 'asset-b';
  await expect(hydrator.activate('asset-b', { previousCacheId: 'asset-a' }))
    .resolves.toBe(true);
  oldMedia.reject(new Error('private stale project path'));
  await expect(stale).resolves.toBe(false);
  expect(apply).toHaveBeenNthCalledWith(1, null);
  expect(apply).toHaveBeenNthCalledWith(2, rows('media B'));
});
