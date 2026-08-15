import {
  activateProjectSnapshot,
  deactivateProject,
  getActiveProjectSnapshot,
} from './projectService';
import { isUuidV7 } from './projectSnapshotAdapter';

const RESOLVED_PROJECT_KEYS = Object.freeze(['cacheId', 'projectId', 'snapshot']);
const SNAPSHOT_KEYS = Object.freeze(['media', 'metadata', 'stateVersion', 'tracks']);
const METADATA_KEYS = Object.freeze(['id', 'name']);

export class MediaProjectActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaProjectActivationError';
    this.code = code;
  }
}

const invalidMediaProject = () => new MediaProjectActivationError(
  'invalidMediaProject',
  'A resolved media project is required'
);

const mediaProjectActivationLost = () => new MediaProjectActivationError(
  'mediaProjectActivationLost',
  'The media project changed before it could own the media operation'
);

const dataDescriptors = (value, allowedKeys, { exact = false } = {}) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidMediaProject();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidMediaProject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))
      || (exact && keys.length !== allowedKeys.length)) {
    throw invalidMediaProject();
  }
  return descriptors;
};

const readValue = (descriptors, key) => {
  const descriptor = descriptors[key];
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    throw invalidMediaProject();
  }
  return descriptor.value;
};

/**
 * Validate a `subtitleProjectStore` resolution without reading hostile accessors and expose only
 * the exact identity the native media claim ABI accepts.
 */
export const normalizeResolvedMediaProject = (value) => {
  try {
    const resolved = dataDescriptors(value, RESOLVED_PROJECT_KEYS);
    const projectId = readValue(resolved, 'projectId');
    const snapshotValue = readValue(resolved, 'snapshot');
    const snapshot = dataDescriptors(snapshotValue, SNAPSHOT_KEYS, { exact: true });
    const metadata = dataDescriptors(
      readValue(snapshot, 'metadata'),
      METADATA_KEYS,
      { exact: true }
    );
    const stateVersion = readValue(snapshot, 'stateVersion');
    if (!isUuidV7(projectId)
        || readValue(metadata, 'id') !== projectId
        || typeof readValue(metadata, 'name') !== 'string'
        || !Number.isSafeInteger(stateVersion)
        || stateVersion < 0
        || !Array.isArray(readValue(snapshot, 'media'))
        || !Array.isArray(readValue(snapshot, 'tracks'))) {
      throw invalidMediaProject();
    }
    return Object.freeze({
      projectId,
      expectedStateVersion: stateVersion,
      snapshot: snapshotValue,
    });
  } catch {
    throw invalidMediaProject();
  }
};

/**
 * Explicit active-project publication for media operations.
 *
 * `projectService` keeps every storage operation detached: creating, reading, or mutating a
 * project never publishes it as the active project. Native media claim/open deliberately require
 * an exact active project, so a caller which has already validated cache/source/project identity
 * publishes that exact resolved snapshot here — the only place a media operation may activate.
 * Activation intents are ordered, so a stale operation can neither publish over a newer revision
 * of the same project nor release a project a newer intent now owns.
 */
export const createMediaProjectActivation = ({
  activateSnapshot = activateProjectSnapshot,
  deactivate = deactivateProject,
  getActiveSnapshot = getActiveProjectSnapshot,
} = {}) => {
  let latestIntent = 0;

  const publishedSnapshot = () => {
    const active = getActiveSnapshot();
    return active !== null && typeof active === 'object' && !Array.isArray(active)
      ? active
      : null;
  };

  const isExactlyPublished = (projectId, expectedStateVersion) => {
    const active = publishedSnapshot();
    return active?.metadata?.id === projectId && active.stateVersion === expectedStateVersion;
  };

  const release = (intent, projectId, publishedStateVersion) => {
    // A newer intent owns the publication channel; releasing here would clobber it.
    if (intent !== latestIntent) return false;
    // A later revision of the same project is published, so a concurrent operation committed on
    // top of this publication and owns it now. Only an untouched publication may be withdrawn.
    if (!isExactlyPublished(projectId, publishedStateVersion)) return false;
    return deactivate({ expectedProjectId: projectId }) === true;
  };

  const activateResolvedProject = async (resolved, { validateOwnership = null } = {}) => {
    const { projectId, expectedStateVersion, snapshot } = normalizeResolvedMediaProject(resolved);
    if (validateOwnership !== null && typeof validateOwnership !== 'function') {
      throw invalidMediaProject();
    }
    const assertOwned = async () => {
      if (validateOwnership !== null) await validateOwnership();
    };

    await assertOwned();
    const current = publishedSnapshot();
    if (current?.metadata?.id === projectId && current.stateVersion > expectedStateVersion) {
      // A newer revision of the same project is already published. Republishing this older
      // resolution would regress every subscriber and let a stale claim commit over newer work.
      throw mediaProjectActivationLost();
    }

    // Claim the newest intent and publish in the same synchronous step, so no other activation
    // can interleave between the claim and the publication it authorises.
    latestIntent += 1;
    const intent = latestIntent;
    try {
      activateSnapshot(snapshot);
    } catch {
      // Snapshot validation runs before publication, so nothing was published to release.
      throw invalidMediaProject();
    }

    try {
      // A subscriber may have synchronously activated another project during publication.
      if (!isExactlyPublished(projectId, expectedStateVersion)) throw mediaProjectActivationLost();
      await assertOwned();
      if (intent !== latestIntent || !isExactlyPublished(projectId, expectedStateVersion)) {
        throw mediaProjectActivationLost();
      }
    } catch (error) {
      release(intent, projectId, expectedStateVersion);
      throw error;
    }

    return Object.freeze({
      claimOptions: Object.freeze({ expectedStateVersion, projectId }),
      release: () => release(intent, projectId, expectedStateVersion),
    });
  };

  return Object.freeze({ activateResolvedProject });
};

const mediaProjectActivation = createMediaProjectActivation();

export const activateResolvedMediaProject = mediaProjectActivation.activateResolvedProject;
