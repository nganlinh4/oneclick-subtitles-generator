// The editor's native media session: select, read, open/restore, clear and drop-claim.
import { invokeDesktop } from './desktopRuntime';
import {
  invalidMediaRequest,
  invalidMediaResponse,
  isUuidV7,
  normalizeSnapshot,
  validateAssetId,
  validateOfferId,
  validatePlaybackId,
} from './mediaDescriptors';
import { getActiveProjectSnapshot } from './projectService';

export const selectMedia = async () => {
  const snapshot = await invokeDesktop('select_media', {});
  return snapshot === null ? null : normalizeSnapshot(snapshot);
};

export const getSelectedMedia = async () => normalizeSnapshot(
  await invokeDesktop('get_session_snapshot', {})
);

const openMediaAssetWithMode = async (assetId, onlyIfEmpty) => {
  const requestedAssetId = validateAssetId(assetId);
  const project = getActiveProjectSnapshot();
  if (!project
      || !isUuidV7(project.metadata?.id)
      || !Number.isSafeInteger(project.stateVersion)
      || project.stateVersion < 0
      || !Array.isArray(project.media)
      || !project.media.some((asset) => asset?.id === requestedAssetId)) {
    throw invalidMediaRequest();
  }
  const snapshot = await invokeDesktop('open_media_asset', {
    id: requestedAssetId,
    projectId: project.metadata.id,
    expectedStateVersion: project.stateVersion,
    onlyIfEmpty,
  });
  if (snapshot === null && onlyIfEmpty) return null;

  const descriptor = normalizeSnapshot(snapshot, { requireMedia: true });
  if (descriptor.assetId !== requestedAssetId) throw invalidMediaResponse();
  return descriptor;
};

export const openMediaAsset = async (assetId) => openMediaAssetWithMode(assetId, false);

export const restoreMediaAsset = async (assetId) => openMediaAssetWithMode(assetId, true);

export const clearMedia = async ({
  expectedAssetId = null,
  expectedPlaybackId = null,
} = {}) => {
  const hasExpectedIdentity = expectedAssetId !== null || expectedPlaybackId !== null;
  if (hasExpectedIdentity && (expectedAssetId === null || expectedPlaybackId === null)) {
    throw invalidMediaRequest();
  }
  const request = hasExpectedIdentity
    ? {
      expectedAssetId: validateAssetId(expectedAssetId),
      expectedPlaybackId: validatePlaybackId(expectedPlaybackId),
    }
    : { expectedAssetId: null, expectedPlaybackId: null };
  return normalizeSnapshot(
    await invokeDesktop('clear_media', request),
    { requireEmpty: true }
  );
};

export const claimMediaDrop = async (offerId) => normalizeSnapshot(
  await invokeDesktop('media_drop_claim', { offerId: validateOfferId(offerId) }),
  { requireMedia: true }
);
