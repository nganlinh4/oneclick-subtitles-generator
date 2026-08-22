import { reconcileSelectedNativeMedia } from './FileUploadInput';

const MEDIA = Object.freeze({ assetId: '019ffa3d-8e35-7f92-b3e3-607dd27bb263' });
const SESSION = Object.freeze({
  assetId: MEDIA.assetId,
  cacheId: 'jNQXAC9IVRw',
  projectId: '019ffa3d-8e35-7f92-b3e3-607dd27bb264',
});

test('a remount preserves the URL alias instead of reactivating downloaded media as a local file', async () => {
  const activateAsLocal = vi.fn();
  const applyOwnedSession = vi.fn();

  await expect(reconcileSelectedNativeMedia({
    media: MEDIA,
    activateAsLocal,
    applyOwnedSession,
    readSession: () => SESSION,
    resolveOwner: vi.fn(async () => ({ projectId: SESSION.projectId })),
  })).resolves.toBe('owned-session');

  expect(activateAsLocal).not.toHaveBeenCalled();
  expect(applyOwnedSession).toHaveBeenCalledExactlyOnceWith(MEDIA, SESSION);
});

test('media with no durable session remains a genuine local activation', async () => {
  const activateAsLocal = vi.fn(async () => undefined);
  const applyOwnedSession = vi.fn();

  await expect(reconcileSelectedNativeMedia({
    media: MEDIA,
    activateAsLocal,
    applyOwnedSession,
    readSession: () => null,
    resolveOwner: vi.fn(),
  })).resolves.toBe('local');

  expect(activateAsLocal).toHaveBeenCalledExactlyOnceWith(MEDIA);
  expect(applyOwnedSession).not.toHaveBeenCalled();
});

test('a stale matching session fails closed instead of minting an asset-keyed project', async () => {
  const activateAsLocal = vi.fn();
  await expect(reconcileSelectedNativeMedia({
    media: MEDIA,
    activateAsLocal,
    applyOwnedSession: vi.fn(),
    readSession: () => SESSION,
    resolveOwner: vi.fn(async () => null),
  })).rejects.toThrow(/no longer available/i);
  expect(activateAsLocal).not.toHaveBeenCalled();
});
