// Downloaded media candidates: commit into the exact active project, open, or roll back; and
// discard of a candidate no project claimed.
import { invokeDesktop } from './desktopRuntime';
import { flushDurableLyricsHistory } from './durableLyricsCheckpoint';
import {
  invalidMediaRequest,
  invalidMediaResponse,
  isNativeMediaDescriptor,
  isUuidV7,
  MEDIA_KEYS,
  normalizeMediaCandidate,
  snapshotExactDataRecord,
  validateAssetId,
} from './mediaDescriptors';
import { openMediaAsset } from './mediaSessionCommands';
import {
  getActiveProjectSnapshot,
  mutateProject,
  undoDetachedProject,
} from './projectService';

const normalizeCandidateClaimOptions = (value) => {
  const options = snapshotExactDataRecord(
    value,
    ['expectedStateVersion', 'projectId'],
    invalidMediaRequest
  );
  if (!isUuidV7(options.projectId)
      || !Number.isSafeInteger(options.expectedStateVersion)
      || options.expectedStateVersion < 0) {
    throw invalidMediaRequest();
  }
  return options;
};

const candidateProjectSnapshot = (value, options, asset) => {
  const project = snapshotExactDataRecord(
    value,
    ['metadata', 'stateVersion', 'media', 'tracks'],
    invalidMediaRequest
  );
  const metadata = snapshotExactDataRecord(
    project.metadata,
    ['id', 'name'],
    invalidMediaRequest
  );
  if (metadata.id !== options.projectId
      || project.stateVersion !== options.expectedStateVersion
      || !Array.isArray(project.media)
      || !Array.isArray(project.tracks)) {
    throw invalidMediaRequest();
  }
  return Object.freeze({
    metadata,
    stateVersion: project.stateVersion,
    media: Object.freeze([asset]),
    tracks: project.tracks,
  });
};

const committedCandidateSnapshot = (value, options, asset) => {
  let commit;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw invalidMediaResponse();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidMediaResponse();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const required = ['revisionId', 'stateVersion', 'snapshot'];
    if (keys.some((key) => typeof key !== 'string'
          || ![...required, 'committed'].includes(key))
        || required.some((key) => !keys.includes(key))) {
      throw invalidMediaResponse();
    }
    commit = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw invalidMediaResponse();
      }
      commit[key] = descriptor.value;
    }
    commit = Object.freeze(commit);
  } catch {
    throw invalidMediaResponse();
  }
  if ((Object.hasOwn(commit, 'committed') && commit.committed !== false)
      || !Number.isSafeInteger(commit.stateVersion)
      || (commit.stateVersion !== options.expectedStateVersion
        && commit.stateVersion !== options.expectedStateVersion + 1)) {
    throw invalidMediaResponse();
  }
  const snapshot = snapshotExactDataRecord(
    commit.snapshot,
    ['metadata', 'stateVersion', 'media', 'tracks'],
    invalidMediaResponse
  );
  const metadata = snapshotExactDataRecord(
    snapshot.metadata,
    ['id', 'name'],
    invalidMediaResponse
  );
  if (metadata.id !== options.projectId
      || snapshot.stateVersion !== commit.stateVersion
      || !Array.isArray(snapshot.media)
      || snapshot.media.length !== 1
      || !Array.isArray(snapshot.tracks)) {
    throw invalidMediaResponse();
  }
  const committedAsset = snapshotExactDataRecord(snapshot.media[0], MEDIA_KEYS, invalidMediaResponse);
  if (committedAsset.id !== asset.id
      || committedAsset.displayName !== asset.displayName
      || committedAsset.extension !== asset.extension
      || committedAsset.sizeBytes !== asset.sizeBytes
      || committedAsset.kind !== asset.kind) {
    throw invalidMediaResponse();
  }
  return Object.freeze({
    committed: commit.committed !== false,
    stateVersion: commit.stateVersion,
  });
};

const requireActiveCandidateProject = (value, options, stateVersion, asset = null) => {
  const project = snapshotExactDataRecord(
    value,
    ['metadata', 'stateVersion', 'media', 'tracks'],
    invalidMediaRequest
  );
  const metadata = snapshotExactDataRecord(
    project.metadata,
    ['id', 'name'],
    invalidMediaRequest
  );
  if (metadata.id !== options.projectId
      || project.stateVersion !== stateVersion
      || !Array.isArray(project.media)
      || !Array.isArray(project.tracks)) {
    throw invalidMediaRequest();
  }
  if (asset !== null) {
    if (project.media.length !== 1) throw invalidMediaRequest();
    const currentAsset = snapshotExactDataRecord(project.media[0], MEDIA_KEYS, invalidMediaRequest);
    if (currentAsset.id !== asset.id
        || currentAsset.displayName !== asset.displayName
        || currentAsset.extension !== asset.extension
        || currentAsset.sizeBytes !== asset.sizeBytes
        || currentAsset.kind !== asset.kind) {
      throw invalidMediaRequest();
    }
  }
  return project;
};

export const createMediaCandidateLifecycle = ({
  getActiveSnapshot = getActiveProjectSnapshot,
  invokeCommand = invokeDesktop,
  mutate = mutateProject,
  openAsset = openMediaAsset,
  rollbackMutation = undoDetachedProject,
  flushSubtitleEdits = flushDurableLyricsHistory,
} = {}) => Object.freeze({
  claim: async (rawCandidate, rawOptions, { validateOwnership = null } = {}) => {
    const candidate = normalizeMediaCandidate(rawCandidate);
    const options = normalizeCandidateClaimOptions(rawOptions);
    if (validateOwnership !== null && typeof validateOwnership !== 'function') {
      throw invalidMediaRequest();
    }
    const assertOwned = async () => {
      if (validateOwnership !== null) await validateOwnership();
    };
    await assertOwned();
    requireActiveCandidateProject(
      getActiveSnapshot(),
      options,
      options.expectedStateVersion
    );
    // A completed background download has no authority to advance the project underneath pending
    // subtitle edits. Flush before the first mutation, then revalidate the exact active revision:
    // either both state models agree, or the candidate stays disposable and the user's project is
    // untouched. Automatic generation also checkpoints earlier, but manual/repeated downloads do
    // not necessarily pass through that flow.
    await flushSubtitleEdits();
    await assertOwned();
    requireActiveCandidateProject(
      getActiveSnapshot(),
      options,
      options.expectedStateVersion
    );
    await assertOwned();
    const commitReason = `Replace project media with downloaded candidate ${candidate.asset.id}`;
    let committed = false;
    try {
      const commit = await mutate(
        options.projectId,
        commitReason,
        (project) => candidateProjectSnapshot(project, options, candidate.asset),
        { retryOnConflict: false }
      );
      const commitReceipt = committedCandidateSnapshot(commit, options, candidate.asset);
      committed = commitReceipt.committed;
      await assertOwned();
      requireActiveCandidateProject(
        getActiveSnapshot(),
        options,
        commitReceipt.stateVersion,
        candidate.asset
      );
      await assertOwned();
      const descriptor = await openAsset(candidate.asset.id);
      await assertOwned();
      requireActiveCandidateProject(
        getActiveSnapshot(),
        options,
        commitReceipt.stateVersion,
        candidate.asset
      );
      if (!isNativeMediaDescriptor(descriptor) || descriptor.assetId !== candidate.asset.id) {
        throw invalidMediaResponse();
      }
      return descriptor;
    } catch (error) {
      if (committed) {
        try {
          // The asset ID makes this history reason acquisition-specific. If another revision has
          // already won, the exact-reason undo refuses instead of reverting that newer work.
          await rollbackMutation(options.projectId, commitReason);
        } catch {
          // Preserve the ownership/open refusal. A conflicting newer revision is authoritative.
        }
      }
      throw error;
    }
  },
  discard: async (assetId) => {
    const discarded = await invokeCommand('discard_media_candidate', {
      id: validateAssetId(assetId),
    });
    if (typeof discarded !== 'boolean') throw invalidMediaResponse();
    return discarded;
  },
});

const mediaCandidateLifecycle = createMediaCandidateLifecycle();

export const claimMediaCandidate = mediaCandidateLifecycle.claim;
export const discardMediaCandidate = mediaCandidateLifecycle.discard;
