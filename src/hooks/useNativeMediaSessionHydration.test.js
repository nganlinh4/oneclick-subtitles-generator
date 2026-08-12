import { createNativeMediaSessionHydrator } from './useNativeMediaSessionHydration';
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

it('fails closed for an empty, failed, superseded, or disposed session read', async () => {
  const apply = vi.fn();
  const empty = createNativeMediaSessionHydrator({
    read: async () => null,
    readStoredAssetId: () => null,
    apply,
  });
  await expect(empty.hydrate()).resolves.toBe(false);

  const failed = createNativeMediaSessionHydrator({
    read: async () => { throw new Error('private native session detail'); },
    readStoredAssetId: () => null,
    apply,
  });
  await expect(failed.hydrate()).resolves.toBe(false);

  const pending = deferred();
  const disposed = createNativeMediaSessionHydrator({
    read: () => pending.promise,
    readStoredAssetId: () => null,
    apply,
  });
  const request = disposed.hydrate();
  disposed.dispose();
  pending.resolve(MEDIA_A);
  await expect(request).resolves.toBe(false);
  expect(apply).not.toHaveBeenCalled();
});
