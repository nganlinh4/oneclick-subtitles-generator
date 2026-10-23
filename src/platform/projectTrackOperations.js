// Per-track editor history commands (status, commit, undo, redo) for the project service. Runs
// through the shared project command gate and publishes authoritative results like every other
// project operation.
import {
  STALE_PROJECT_VERSION,
  TRACK_HISTORY_CONFLICT_CODES,
  ProjectConflictError,
  ProjectServiceError,
  copySnapshot,
  freezeTree,
  normalizeStandaloneTrack,
  normalizeTrackHistoryStatus,
  normalizeTrackSelector,
  validateProjectId,
  validateReason,
} from './projectServiceContract';

export const createProjectTrackOperations = ({
  enqueueProject,
  invoke,
  readDirect,
  requireProjectDirect,
  reloadAfterConflict,
  refreshActiveProject,
  getActivationGeneration,
}) => {
  const trackHistoryStatusDetached = (id, selector) => {
    const projectId = validateProjectId(id);
    const trackSelector = normalizeTrackSelector(selector);
    const expectedActivationGeneration = getActivationGeneration();
    return enqueueProject(projectId, async () => {
      let snapshot = await requireProjectDirect(projectId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const status = normalizeTrackHistoryStatus(await invoke(
          'project_track_history_status',
          { id: projectId, selector: trackSelector }
        ));
        if (status.stateVersion === snapshot.stateVersion) {
          refreshActiveProject(projectId, snapshot, expectedActivationGeneration);
          return status;
        }
        const loaded = await readDirect(projectId);
        if (loaded === null) {
          throw new ProjectServiceError('projectNotFound', 'The project does not exist', {
            projectId,
          });
        }
        snapshot = loaded;
        if (status.stateVersion === snapshot.stateVersion) {
          refreshActiveProject(projectId, snapshot, expectedActivationGeneration);
          return status;
        }
      }
      return reloadAfterConflict(
        projectId,
        new ProjectServiceError(
          STALE_PROJECT_VERSION,
          'The project changed while its editor history was being inspected'
        ),
        expectedActivationGeneration
      );
    });
  };

  const validateTrackMutation = (value, projectId) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProjectServiceError(
        'invalidProjectTrackMutation',
        'The desktop host returned an invalid project track mutation'
      );
    }
    const snapshot = copySnapshot(value.snapshot);
    const status = normalizeTrackHistoryStatus(value.status);
    if (snapshot.metadata.id !== projectId || status.stateVersion !== snapshot.stateVersion) {
      throw new ProjectServiceError(
        'invalidProjectTrackMutation',
        'The desktop host returned an inconsistent project track mutation'
      );
    }
    return freezeTree({ snapshot, status });
  };

  const reloadTrackConflict = async (
    projectId,
    cause,
    expectedActivationGeneration
  ) => {
    let authoritativeSnapshot = null;
    try {
      authoritativeSnapshot = await readDirect(projectId);
    } catch (reloadError) {
      throw new ProjectServiceError(
        'projectReloadFailed',
        'The subtitle history conflicted and could not be reloaded',
        { projectId, cause, reloadError }
      );
    }
    refreshActiveProject(projectId, authoritativeSnapshot, expectedActivationGeneration);
    throw new ProjectConflictError(projectId, authoritativeSnapshot, cause);
  };

  const commitTrackDetached = ({
    id,
    selector,
    expectedHistoryVersion,
    beforeTrack,
    afterTrack,
    reason,
  }) => {
    const projectId = validateProjectId(id);
    const trackSelector = normalizeTrackSelector(selector);
    const historyVersion = Number.isSafeInteger(expectedHistoryVersion)
        && expectedHistoryVersion >= 0
      ? expectedHistoryVersion
      : null;
    if (historyVersion === null) {
      throw new ProjectServiceError(
        'invalidProjectTrackHistoryVersion',
        'A valid project track history version is required'
      );
    }
    const previous = normalizeStandaloneTrack(beforeTrack, projectId);
    const next = normalizeStandaloneTrack(afterTrack, projectId);
    const revisionReason = validateReason(reason);
    const expectedActivationGeneration = getActivationGeneration();
    return enqueueProject(projectId, async () => {
      await requireProjectDirect(projectId);
      try {
        const result = validateTrackMutation(await invoke('project_track_commit', {
          id: projectId,
          selector: trackSelector,
          expectedHistoryVersion: historyVersion,
          beforeTrack: previous,
          afterTrack: next,
          reason: revisionReason,
        }), projectId);
        refreshActiveProject(
          projectId,
          result.snapshot,
          expectedActivationGeneration
        );
        return result;
      } catch (error) {
        if (TRACK_HISTORY_CONFLICT_CODES.has(error?.code)) {
          return reloadTrackConflict(projectId, error, expectedActivationGeneration);
        }
        throw error;
      }
    });
  };

  const navigateTrackDetached = (command, {
    id,
    selector,
    expectedHistoryVersion,
    expectedReason,
  }) => {
    const projectId = validateProjectId(id);
    const trackSelector = normalizeTrackSelector(selector);
    if (!Number.isSafeInteger(expectedHistoryVersion) || expectedHistoryVersion < 0) {
      throw new ProjectServiceError(
        'invalidProjectTrackHistoryVersion',
        'A valid project track history version is required'
      );
    }
    const reason = validateReason(expectedReason);
    const expectedActivationGeneration = getActivationGeneration();
    return enqueueProject(projectId, async () => {
      const snapshot = await requireProjectDirect(projectId);
      try {
        const value = await invoke(command, {
          id: projectId,
          selector: trackSelector,
          expectedHistoryVersion,
          expectedReason: reason,
        });
        if (value === null) {
          refreshActiveProject(projectId, snapshot, expectedActivationGeneration);
          return null;
        }
        const result = validateTrackMutation(value, projectId);
        refreshActiveProject(
          projectId,
          result.snapshot,
          expectedActivationGeneration
        );
        return result;
      } catch (error) {
        if (TRACK_HISTORY_CONFLICT_CODES.has(error?.code)) {
          return reloadTrackConflict(projectId, error, expectedActivationGeneration);
        }
        throw error;
      }
    });
  };

  return Object.freeze({
    trackHistoryStatusDetached,
    commitTrackDetached,
    undoDetachedTrack: (options) => navigateTrackDetached('project_track_undo', options),
    redoDetachedTrack: (options) => navigateTrackDetached('project_track_redo', options),
  });
};
