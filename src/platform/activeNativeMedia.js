import { isDesktopRuntime } from './desktopRuntime';
import {
  getSelectedMedia,
  isNativeMediaDescriptor,
  restoreMediaAsset,
} from './mediaService';
import {
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from './nativeMediaOwnership';
import { isUuidV7 } from './projectSnapshotAdapter';
import {
  getActiveProjectSnapshot,
  subscribeToActiveProject,
} from './projectService';

const MAX_CACHE_ID_CHARACTERS = 8_192;
let activeProjectEpoch = 0;
subscribeToActiveProject(() => {
  activeProjectEpoch += 1;
});

export class ActiveNativeMediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActiveNativeMediaError';
    this.code = code;
  }
}

const unavailable = (code = 'activeNativeMediaUnavailable') => new ActiveNativeMediaError(
  code,
  'The active native media changed or is unavailable'
);

const isSafeStateVersion = (value) => Number.isSafeInteger(value) && value >= 0;
const isCacheId = (value) => (
  typeof value === 'string' && value.length > 0 && value.length <= MAX_CACHE_ID_CHARACTERS
);

const exactPrimaryAsset = (snapshot) => {
  if (!snapshot
      || !isUuidV7(snapshot.metadata?.id)
      || !isSafeStateVersion(snapshot.stateVersion)
      || !Array.isArray(snapshot.media)
      || snapshot.media.length !== 1) {
    throw unavailable();
  }
  const asset = snapshot.media[0];
  if (!asset
      || !isUuidV7(asset.id)
      || typeof asset.displayName !== 'string'
      || asset.displayName.length === 0
      || typeof asset.extension !== 'string'
      || asset.extension.length === 0
      || !Number.isSafeInteger(asset.sizeBytes)
      || asset.sizeBytes <= 0
      || (asset.kind !== 'audio' && asset.kind !== 'video')) {
    throw unavailable();
  }
  return asset;
};

const sameAsset = (left, right) => (
  left?.id === right?.id
  && left.displayName === right.displayName
  && left.extension === right.extension
  && left.sizeBytes === right.sizeBytes
  && left.kind === right.kind
);

const sameProjectRevision = (snapshot, identity) => {
  try {
    return snapshot?.metadata?.id === identity.projectId
      && snapshot.stateVersion === identity.stateVersion
      && snapshot.media.length === 1
      && sameAsset(snapshot.media[0], identity.asset);
  } catch {
    return false;
  }
};

const sameSession = (session, identity) => (
  session?.assetId === identity.asset.id
  && session.projectId === identity.projectId
  && session.cacheId === identity.cacheId
);

const descriptorMatchesAsset = (descriptor, asset) => (
  isNativeMediaDescriptor(descriptor)
  && descriptor.assetId === asset.id
  && descriptor.name === asset.displayName
  && descriptor.size === asset.sizeBytes
  && descriptor.type.startsWith(`${asset.kind}/`)
);

const candidateMatchesDescriptor = (candidate, descriptor) => (
  candidate === undefined
  || candidate === null
  || (isNativeMediaDescriptor(candidate)
    ? candidate.assetId === descriptor.assetId
      && candidate.playbackId === descriptor.playbackId
      && candidate.playbackUrl === descriptor.playbackUrl
    : typeof candidate === 'string' && candidate === descriptor.playbackUrl)
);

/**
 * Resolve the only media a desktop operation may call "active".
 *
 * Browser compatibility keys are intentionally absent. Authority is the intersection of:
 *   1. the exact active project revision and its sole primary media asset;
 *   2. the durable alias session, re-resolved without creating a project; and
 *   3. the native playback session for those exact bytes.
 *
 * Every asynchronous boundary is followed by a fresh project/session comparison. This makes an
 * A -> B switch, undo, media replacement, alias remap, or native-session replacement a refusal
 * instead of silently operating on whichever stale value happened to finish last.
 */
export const createActiveNativeMediaResolver = ({
  isDesktop = isDesktopRuntime,
  getActiveSnapshot = getActiveProjectSnapshot,
  readSession = readNativeMediaSession,
  resolveOwner = resolveOwnedNativeMediaProject,
  getPlayback = getSelectedMedia,
  restorePlayback = restoreMediaAsset,
  readActivationEpoch = () => activeProjectEpoch,
} = {}) => {
  if (typeof isDesktop !== 'function'
      || typeof getActiveSnapshot !== 'function'
      || typeof readSession !== 'function'
      || typeof resolveOwner !== 'function'
      || typeof getPlayback !== 'function'
      || typeof restorePlayback !== 'function'
      || typeof readActivationEpoch !== 'function') {
    throw new TypeError('Active native media resolution requires reviewed dependencies');
  }

  const resolve = async ({ candidate = null, restore = false } = {}) => {
    if (isDesktop() !== true) throw unavailable('nativeRuntimeRequired');

    const capturedProject = getActiveSnapshot();
    const asset = exactPrimaryAsset(capturedProject);
    const capturedEpoch = readActivationEpoch();
    if (!Number.isSafeInteger(capturedEpoch) || capturedEpoch < 0) throw unavailable();
    const session = readSession();
    if (!isCacheId(session?.cacheId)
        || session.assetId !== asset.id
        || session.projectId !== capturedProject.metadata.id) {
      throw unavailable();
    }
    const identity = Object.freeze({
      projectId: capturedProject.metadata.id,
      stateVersion: capturedProject.stateVersion,
      cacheId: session.cacheId,
      asset: Object.freeze({ ...asset }),
      epoch: capturedEpoch,
    });

    const assertLocalIdentity = () => {
      if (readActivationEpoch() !== identity.epoch
          || !sameProjectRevision(getActiveSnapshot(), identity)
          || !sameSession(readSession(), identity)) {
        throw unavailable('activeNativeMediaChanged');
      }
    };

    const assertDurableOwner = async () => {
      assertLocalIdentity();
      const owner = await resolveOwner(session);
      assertLocalIdentity();
      if (owner?.projectId !== identity.projectId
          || owner.snapshot?.stateVersion !== identity.stateVersion
          || !Array.isArray(owner.snapshot?.media)
          || owner.snapshot.media.length !== 1
          || !sameAsset(owner.snapshot.media[0], identity.asset)) {
        throw unavailable('activeNativeMediaChanged');
      }
    };

    await assertDurableOwner();
    let descriptor = await getPlayback();
    assertLocalIdentity();
    if (descriptor === null && restore === true) {
      descriptor = await restorePlayback(identity.asset.id);
      assertLocalIdentity();
    }
    if (!descriptorMatchesAsset(descriptor, identity.asset)
        || !candidateMatchesDescriptor(candidate, descriptor)) {
      throw unavailable();
    }
    // Resolve the alias again after native playback acquisition. The first resolution cannot
    // protect against an alias repair/remap that wins while the host call is in flight.
    await assertDurableOwner();

    return Object.freeze({
      projectId: identity.projectId,
      stateVersion: identity.stateVersion,
      cacheId: identity.cacheId,
      assetId: identity.asset.id,
      media: descriptor,
    });
  };

  const revalidate = async (capability) => {
    if (!capability
        || !isUuidV7(capability.projectId)
        || !isSafeStateVersion(capability.stateVersion)
        || !isCacheId(capability.cacheId)
        || !isUuidV7(capability.assetId)
        || !isNativeMediaDescriptor(capability.media)) {
      throw unavailable();
    }
    const current = await resolve({ candidate: capability.media });
    if (current.projectId !== capability.projectId
        || current.stateVersion !== capability.stateVersion
        || current.cacheId !== capability.cacheId
        || current.assetId !== capability.assetId
        || current.media.playbackId !== capability.media.playbackId
        || current.media.playbackUrl !== capability.media.playbackUrl) {
      throw unavailable('activeNativeMediaChanged');
    }
    return current;
  };

  const refresh = async (capability) => {
    if (!capability
        || !isUuidV7(capability.projectId)
        || !isSafeStateVersion(capability.stateVersion)
        || !isCacheId(capability.cacheId)
        || !isUuidV7(capability.assetId)
        || !isNativeMediaDescriptor(capability.media)) {
      throw unavailable();
    }
    const current = await resolve({ candidate: capability.media });
    if (current.projectId !== capability.projectId
        || current.stateVersion < capability.stateVersion
        || current.cacheId !== capability.cacheId
        || current.assetId !== capability.assetId
        || current.media.playbackId !== capability.media.playbackId
        || current.media.playbackUrl !== capability.media.playbackUrl) {
      throw unavailable('activeNativeMediaChanged');
    }
    return current;
  };

  return Object.freeze({ resolve, revalidate, refresh });
};

const activeNativeMediaResolver = createActiveNativeMediaResolver();

export const resolveActiveNativeMedia = activeNativeMediaResolver.resolve;
export const revalidateActiveNativeMedia = activeNativeMediaResolver.revalidate;
export const refreshActiveNativeMedia = activeNativeMediaResolver.refresh;

/**
 * Compatibility for descriptor-only call sites while they migrate to the asynchronous capability.
 * A bare playback URL can never prove project ownership and is therefore rejected.
 */
export const resolveActiveNativeMediaAssetId = (value) => (
  isDesktopRuntime() && isNativeMediaDescriptor(value) ? value.assetId : null
);
