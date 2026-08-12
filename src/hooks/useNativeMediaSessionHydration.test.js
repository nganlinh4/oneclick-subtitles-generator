import {
  applyNativeMediaSession,
  createNativeMediaSessionHydrator,
} from './useNativeMediaSessionHydration';
import { createNativeMediaDescriptor } from '../platform/mediaService';

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const ASSET_A = '018f47a2-7c20-7f70-8000-000000000001';
const ASSET_B = '018f47a2-7c20-7f70-8000-000000000002';

const mediaDescriptor = ({
  assetId,
  playbackId,
  token,
}) => createNativeMediaDescriptor({
  asset: {
    displayName: 'fixture.mp4',
    extension: 'mp4',
    id: assetId,
    kind: 'video',
    sizeBytes: 10,
  },
  playback: {
    byteLength: 10,
    id: playbackId,
    mimeType: 'video/mp4',
    playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${token}`,
  },
});

const MEDIA_A = mediaDescriptor({
  assetId: ASSET_A,
  playbackId: '123e4567-e89b-42d3-a456-426614174000',
  token: 'a'.repeat(64),
});
const MEDIA_B = mediaDescriptor({
  assetId: ASSET_B,
  playbackId: '123e4567-e89b-42d3-a456-426614174001',
  token: 'b'.repeat(64),
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it('restores an empty fresh native process and publishes the fresh playback capability', async () => {
  const apply = vi.fn();
  const restore = vi.fn().mockResolvedValue(MEDIA_A);
  const hydrator = createNativeMediaSessionHydrator({
    read: async () => null,
    restore,
    readStoredAssetId: () => ASSET_A,
    apply,
  });

  await expect(hydrator.hydrate()).resolves.toBe(true);
  expect(restore).toHaveBeenCalledExactlyOnceWith(ASSET_A);
  expect(apply).toHaveBeenCalledExactlyOnceWith(MEDIA_A);
  expect(MEDIA_A.playbackUrl).toContain(MEDIA_A.playbackId);
});

it('applies the restored identity to media, subtitle, and transcription-rule caches together', () => {
  localStorage.setItem('current_file_url', 'blob:obsolete');
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const setUploadedFile = vi.fn();
  const setRulesCacheIdImpl = vi.fn();
  const setSubtitlesCacheIdImpl = vi.fn();

  applyNativeMediaSession({
    media: MEDIA_A,
    setUploadedFile,
    setRulesCacheIdImpl,
    setSubtitlesCacheIdImpl,
  });

  expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:obsolete');
  expect(localStorage.getItem('current_file_url')).toBe(MEDIA_A.playbackUrl);
  expect(localStorage.getItem('current_file_cache_id')).toBe(ASSET_A);
  expect(setRulesCacheIdImpl).toHaveBeenCalledExactlyOnceWith(ASSET_A);
  expect(setSubtitlesCacheIdImpl).toHaveBeenCalledExactlyOnceWith(ASSET_A);
  expect(setUploadedFile).toHaveBeenCalledExactlyOnceWith(MEDIA_A);
});

it('restores only a session read for the unchanged stored media identity', async () => {
  let storedAssetId = ASSET_A;
  const pending = deferred();
  const apply = vi.fn();
  const hydrator = createNativeMediaSessionHydrator({
    read: () => pending.promise,
    readStoredAssetId: () => storedAssetId,
    apply,
  });

  const stale = hydrator.hydrate();
  storedAssetId = ASSET_B;
  pending.resolve(MEDIA_A);
  await expect(stale).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();

  const fresh = createNativeMediaSessionHydrator({
    read: async () => MEDIA_B,
    readStoredAssetId: () => storedAssetId,
    apply,
  });
  await expect(fresh.hydrate()).resolves.toBe(true);
  expect(apply).toHaveBeenCalledExactlyOnceWith(MEDIA_B);
});

it('rejects a forged or unnormalized native media descriptor', async () => {
  const apply = vi.fn();
  const forged = Object.freeze({ ...MEDIA_A, assetId: 'asset-a' });
  const hydrator = createNativeMediaSessionHydrator({
    read: async () => forged,
    readStoredAssetId: () => ASSET_A,
    apply,
  });

  await expect(hydrator.hydrate()).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('allows only the latest duplicate reconciliation to publish a normalized descriptor', async () => {
  const first = deferred();
  const second = deferred();
  const apply = vi.fn();
  let readCount = 0;
  const hydrator = createNativeMediaSessionHydrator({
    read: () => {
      readCount += 1;
      return readCount === 1 ? first.promise : second.promise;
    },
    readStoredAssetId: () => ASSET_A,
    apply,
  });

  const superseded = hydrator.hydrate();
  const latest = hydrator.hydrate();
  second.resolve(MEDIA_A);
  await expect(latest).resolves.toBe(true);
  first.resolve(MEDIA_A);
  await expect(superseded).resolves.toBe(false);
  expect(apply).toHaveBeenCalledExactlyOnceWith(MEDIA_A);
});

it('fails closed for missing or invalid persisted identities without applying media', async () => {
  const apply = vi.fn();
  const restore = vi.fn();
  const missing = createNativeMediaSessionHydrator({
    read: async () => null,
    restore,
    readStoredAssetId: () => null,
    apply,
  });
  await expect(missing.hydrate()).resolves.toBe(false);
  expect(restore).not.toHaveBeenCalled();

  restore.mockRejectedValueOnce(new Error('invalid UUID'));
  const invalid = createNativeMediaSessionHydrator({
    read: async () => null,
    restore,
    readStoredAssetId: () => 'C:\\private\\clip.mp4',
    apply,
  });
  await expect(invalid.hydrate()).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();

  const unreadable = createNativeMediaSessionHydrator({
    read: async () => MEDIA_A,
    readStoredAssetId: () => { throw new Error('storage unavailable'); },
    apply,
  });
  await expect(unreadable.hydrate()).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('does not apply a restore after the persisted cache identity changes concurrently', async () => {
  let storedAssetId = ASSET_A;
  const pending = deferred();
  const apply = vi.fn();
  const hydrator = createNativeMediaSessionHydrator({
    read: async () => null,
    restore: () => pending.promise,
    readStoredAssetId: () => storedAssetId,
    apply,
  });

  const request = hydrator.hydrate();
  await Promise.resolve();
  storedAssetId = ASSET_B;
  pending.resolve(MEDIA_A);

  await expect(request).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('reconciles the authoritative native winner when guarded restoration loses its commit race', async () => {
  const apply = vi.fn();
  const restore = vi.fn().mockResolvedValue(null);
  const read = vi.fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(MEDIA_B);
  const hydrator = createNativeMediaSessionHydrator({
    read,
    restore,
    readStoredAssetId: () => ASSET_A,
    apply,
  });

  await expect(hydrator.hydrate()).resolves.toBe(true);
  expect(restore).toHaveBeenCalledExactlyOnceWith(ASSET_A);
  expect(read).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledExactlyOnceWith(MEDIA_B);
});

it('reconciles a StrictMode-style disposed restore winner through the replacement hydrator', async () => {
  let nativeMedia = null;
  const firstRestore = deferred();
  const secondRestore = deferred();
  const firstApply = vi.fn();
  const secondApply = vi.fn();
  const read = vi.fn(async () => nativeMedia);
  const restoreFromFirstMount = vi.fn(() => firstRestore.promise);
  const restoreFromReplacement = vi.fn(() => secondRestore.promise);
  const first = createNativeMediaSessionHydrator({
    read,
    restore: restoreFromFirstMount,
    readStoredAssetId: () => ASSET_A,
    apply: firstApply,
  });
  const replacement = createNativeMediaSessionHydrator({
    read,
    restore: restoreFromReplacement,
    readStoredAssetId: () => ASSET_A,
    apply: secondApply,
  });

  const staleRequest = first.hydrate();
  await vi.waitFor(() => expect(restoreFromFirstMount).toHaveBeenCalledExactlyOnceWith(ASSET_A));
  first.dispose();
  const replacementRequest = replacement.hydrate();
  await vi.waitFor(() => expect(restoreFromReplacement).toHaveBeenCalledExactlyOnceWith(ASSET_A));
  nativeMedia = MEDIA_A;
  firstRestore.resolve(MEDIA_A);
  await expect(staleRequest).resolves.toBe(false);
  secondRestore.resolve(null);

  await expect(replacementRequest).resolves.toBe(true);
  expect(firstApply).not.toHaveBeenCalled();
  expect(secondApply).toHaveBeenCalledExactlyOnceWith(MEDIA_A);
});

it.each([
  ['empty', async () => null],
  ['malformed', async () => ({ ...MEDIA_A, playbackUrl: 'file:///private/clip.mp4' })],
  ['failed', async () => { throw new Error('private authoritative read failure'); }],
])('fails closed when the authoritative post-conflict read is %s', async (_case, secondRead) => {
  const apply = vi.fn();
  const read = vi.fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(secondRead);
  const hydrator = createNativeMediaSessionHydrator({
    read,
    restore: async () => null,
    readStoredAssetId: () => ASSET_A,
    apply,
  });

  await expect(hydrator.hydrate()).resolves.toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  expect(apply).not.toHaveBeenCalled();
});

it('discards an authoritative post-conflict read when persisted identity changes in flight', async () => {
  let storedAssetId = ASSET_A;
  const authoritative = deferred();
  const apply = vi.fn();
  const read = vi.fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => authoritative.promise);
  const hydrator = createNativeMediaSessionHydrator({
    read,
    restore: async () => null,
    readStoredAssetId: () => storedAssetId,
    apply,
  });

  const request = hydrator.hydrate();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  storedAssetId = ASSET_B;
  authoritative.resolve(MEDIA_B);

  await expect(request).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('fails closed for malformed session DTOs and reopen failures', async () => {
  const apply = vi.fn();
  const malformedRead = createNativeMediaSessionHydrator({
    read: async () => ({ ...MEDIA_A, playbackUrl: 'file:///private/clip.mp4' }),
    readStoredAssetId: () => ASSET_A,
    apply,
  });
  await expect(malformedRead.hydrate()).resolves.toBe(false);

  const malformedRestore = createNativeMediaSessionHydrator({
    read: async () => null,
    restore: async () => ({ ...MEDIA_A, assetId: ASSET_B }),
    readStoredAssetId: () => ASSET_A,
    apply,
  });
  await expect(malformedRestore.hydrate()).resolves.toBe(false);

  const failedRestore = createNativeMediaSessionHydrator({
    read: async () => null,
    restore: async () => { throw new Error('private reopen failure'); },
    readStoredAssetId: () => ASSET_A,
    apply,
  });
  await expect(failedRestore.hydrate()).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it('fails closed for a failed, superseded, or disposed reconciliation', async () => {
  const apply = vi.fn();
  const failed = createNativeMediaSessionHydrator({
    read: async () => { throw new Error('private native session detail'); },
    readStoredAssetId: () => ASSET_A,
    apply,
  });
  await expect(failed.hydrate()).resolves.toBe(false);

  const firstRestore = deferred();
  let readCount = 0;
  const superseded = createNativeMediaSessionHydrator({
    read: async () => {
      readCount += 1;
      return readCount === 1 ? null : MEDIA_B;
    },
    restore: () => firstRestore.promise,
    readStoredAssetId: () => ASSET_A,
    apply,
  });
  const first = superseded.hydrate();
  await Promise.resolve();
  const second = superseded.hydrate();
  await expect(second).resolves.toBe(true);
  firstRestore.resolve(MEDIA_A);
  await expect(first).resolves.toBe(false);
  expect(apply).toHaveBeenCalledExactlyOnceWith(MEDIA_B);

  apply.mockClear();
  const pending = deferred();
  const disposed = createNativeMediaSessionHydrator({
    read: async () => null,
    restore: () => pending.promise,
    readStoredAssetId: () => ASSET_A,
    apply,
  });
  const request = disposed.hydrate();
  await Promise.resolve();
  disposed.dispose();
  pending.resolve(MEDIA_A);
  await expect(request).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
