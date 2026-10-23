// Release and remount reconciliation of the native media selected in the upload input.
import {
  forgetNativeMediaSessionDurably,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../../platform/nativeMediaOwnership';
import {
  clearMedia,
  isNativeMediaDescriptor,
  restoreMediaAsset,
} from '../../platform/mediaService';

export const reconcileSelectedNativeMedia = async ({
  media,
  activateAsLocal,
  applyOwnedSession,
  readSession = readNativeMediaSession,
  resolveOwner = resolveOwnedNativeMediaProject,
}) => {
  const session = readSession();
  if (session === null) {
    await activateAsLocal(media);
    return 'local';
  }
  if (session.assetId !== media?.assetId) {
    throw new Error('The selected media does not match its active subtitle project.');
  }
  const owner = await resolveOwner(session);
  if (owner === null) {
    throw new Error('The selected media subtitle project is no longer available.');
  }
  await applyOwnedSession(media, session);
  return 'owned-session';
};

export const releaseSelectedNativeMedia = async ({
  media,
  clear = clearMedia,
  readSession = readNativeMediaSession,
  forgetSession = forgetNativeMediaSessionDurably,
  restore = restoreMediaAsset,
}) => {
  if (!isNativeMediaDescriptor(media)
      || typeof clear !== 'function'
      || typeof readSession !== 'function'
      || typeof forgetSession !== 'function'
      || typeof restore !== 'function') {
    throw new TypeError('Exact native media is required for release');
  }
  const session = readSession();
  await clear({
    expectedAssetId: media.assetId,
    expectedPlaybackId: media.playbackId,
  });
  if (session === null || session.assetId !== media.assetId) return null;
  if (await forgetSession({ expectedSession: session }) === true) return session;

  const current = readSession();
  if (current === null
      || current.assetId !== session.assetId
      || current.cacheId !== session.cacheId
      || current.projectId !== session.projectId) {
    return null;
  }

  // The native capability has already been withdrawn, but its exact durable pointer survived.
  // Reopen only if the host is still empty: a newer selection arriving after `clear` must win.
  // Refusing the UI removal after this rollback keeps the visible state and relaunch state equal.
  const restored = await restore(media.assetId);
  if (restored === null) return null;
  if (!isNativeMediaDescriptor(restored)
      || restored.assetId !== media.assetId) {
    throw new Error('The selected media could not be restored after its session remained active.');
  }
  throw Object.assign(new Error('The selected media session could not be removed.'), {
    restoredMedia: restored,
  });
};
