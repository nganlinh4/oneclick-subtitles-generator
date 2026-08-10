import { invokeDesktop } from './desktopRuntime';
import { isUuidV7, normalizeProjectSnapshot } from './projectSnapshotAdapter';

export const STALE_PROJECT_VERSION = 'staleProjectVersion';

export class ProjectServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectServiceError';
    this.code = code;
    Object.assign(this, details);
  }
}

export class ProjectConflictError extends ProjectServiceError {
  constructor(projectId, authoritativeSnapshot, cause) {
    super(
      STALE_PROJECT_VERSION,
      'The project changed since it was opened. The current project has been reloaded.',
      { projectId, authoritativeSnapshot, cause }
    );
    this.name = 'ProjectConflictError';
  }
}

const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});
const TRACK_ORIGINS = new Set(['legacyJson', 'srt']);
const TRACK_HISTORY_CONFLICT_CODES = new Set([
  'staleProjectTrackHistory',
  'projectTrackHistoryDiverged',
]);

const validateProjectId = (id) => {
  if (!isUuidV7(id)) {
    throw new ProjectServiceError('invalidProjectId', 'A valid UUIDv7 project ID is required');
  }
  return id;
};

const validateProjectName = (name) => {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ProjectServiceError('invalidProjectName', 'A project name is required');
  }
  if (Array.from(name.trim()).length > 200 || hasControlCharacter(name)) {
    throw new ProjectServiceError('invalidProjectName', 'The project name is invalid');
  }
  return name;
};

const validateReason = (reason) => {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new ProjectServiceError('invalidRevisionReason', 'A revision reason is required');
  }
  if (Array.from(reason.trim()).length > 500 || hasControlCharacter(reason)) {
    throw new ProjectServiceError('invalidRevisionReason', 'The revision reason is invalid');
  }
  return reason;
};

const validateCommit = (commit, expectedVersion) => {
  if (!commit || !isUuidV7(commit.revisionId)
      || !Number.isSafeInteger(commit.stateVersion)
      || commit.stateVersion !== expectedVersion + 1) {
    throw new ProjectServiceError(
      'invalidProjectCommit',
      'The desktop host returned an invalid project commit result'
    );
  }
  return commit;
};

const normalizeHistoryReason = (value, field) => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0
      || Array.from(value).length > 500 || hasControlCharacter(value)) {
    throw new ProjectServiceError(
      'invalidProjectHistoryStatus',
      `The desktop host returned an invalid ${field}`
    );
  }
  return value;
};

const normalizeHistoryStatus = (status) => {
  if (!status || typeof status !== 'object' || Array.isArray(status)
      || !Number.isSafeInteger(status.stateVersion) || status.stateVersion < 0
      || typeof status.canUndo !== 'boolean' || typeof status.canRedo !== 'boolean') {
    throw new ProjectServiceError(
      'invalidProjectHistoryStatus',
      'The desktop host returned an invalid project history status'
    );
  }
  const undoReason = normalizeHistoryReason(status.undoReason, 'undo reason');
  const redoReason = normalizeHistoryReason(status.redoReason, 'redo reason');
  if (status.canUndo !== (undoReason !== null) || status.canRedo !== (redoReason !== null)) {
    throw new ProjectServiceError(
      'invalidProjectHistoryStatus',
      'The desktop host returned an inconsistent project history status'
    );
  }
  return Object.freeze({
    stateVersion: status.stateVersion,
    canUndo: status.canUndo,
    canRedo: status.canRedo,
    undoReason,
    redoReason,
  });
};

const normalizeTrackSelector = (selector) => {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)
      || typeof selector.label !== 'string' || selector.label.trim().length === 0
      || Array.from(selector.label.trim()).length > 200
      || hasControlCharacter(selector.label)
      || !TRACK_ORIGINS.has(selector.origin)) {
    throw new ProjectServiceError(
      'invalidProjectTrackSelector',
      'A valid project track selector is required'
    );
  }
  return Object.freeze({ label: selector.label.trim(), origin: selector.origin });
};

const normalizeStandaloneTrack = (track, projectId) => {
  if (track === null) return null;
  return normalizeProjectSnapshot({
    metadata: { id: projectId, name: 'Track validation' },
    stateVersion: 0,
    media: [],
    tracks: [track],
  }).tracks[0];
};

const normalizeTrackHistoryStatus = (status) => {
  if (!status || typeof status !== 'object' || Array.isArray(status)
      || !Number.isSafeInteger(status.stateVersion) || status.stateVersion < 0
      || !Number.isSafeInteger(status.historyVersion) || status.historyVersion < 0
      || typeof status.diverged !== 'boolean'
      || typeof status.canUndo !== 'boolean' || typeof status.canRedo !== 'boolean') {
    throw new ProjectServiceError(
      'invalidProjectTrackHistoryStatus',
      'The desktop host returned an invalid project track history status'
    );
  }
  const undoReason = normalizeHistoryReason(status.undoReason, 'track undo reason');
  const redoReason = normalizeHistoryReason(status.redoReason, 'track redo reason');
  if (status.canUndo !== (undoReason !== null) || status.canRedo !== (redoReason !== null)
      || (status.diverged && (status.canUndo || status.canRedo))) {
    throw new ProjectServiceError(
      'invalidProjectTrackHistoryStatus',
      'The desktop host returned an inconsistent project track history status'
    );
  }
  return Object.freeze({
    stateVersion: status.stateVersion,
    historyVersion: status.historyVersion,
    diverged: status.diverged,
    canUndo: status.canUndo,
    canRedo: status.canRedo,
    undoReason,
    redoReason,
  });
};

const isStaleVersionError = (error) => error?.code === STALE_PROJECT_VERSION;

/**
 * Stateful project command bridge. Every operation which can affect the active snapshot shares
 * one promise queue; a rejected operation cannot poison later work.
 */
export const createProjectService = ({ invokeCommand = invokeDesktop } = {}) => {
  let activeSnapshot = null;
  let operationTail = Promise.resolve();
  const subscribers = new Set();

  const publish = () => {
    const snapshot = activeSnapshot == null ? null : normalizeProjectSnapshot(activeSnapshot);
    subscribers.forEach((subscriber) => {
      try {
        subscriber(snapshot);
      } catch (error) {
        console.error('[projectService] Active-project subscriber failed:', error);
      }
    });
  };

  const setActive = (snapshot) => {
    activeSnapshot = snapshot == null ? null : normalizeProjectSnapshot(snapshot);
    publish();
    return activeSnapshot == null ? null : normalizeProjectSnapshot(activeSnapshot);
  };

  const enqueue = (operation) => {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => undefined);
    return result;
  };

  const loadDirect = async (id) => {
    const snapshot = await invokeCommand('project_load', { id: validateProjectId(id) });
    if (snapshot == null) {
      if (activeSnapshot?.metadata.id === id) setActive(null);
      return null;
    }
    return setActive(snapshot);
  };

  const reloadAfterConflict = async (projectId, cause) => {
    let authoritativeSnapshot = null;
    try {
      authoritativeSnapshot = await loadDirect(projectId);
    } catch (reloadError) {
      throw new ProjectServiceError(
        'projectReloadFailed',
        'The project conflicted and could not be reloaded',
        { projectId, cause, reloadError }
      );
    }
    throw new ProjectConflictError(projectId, authoritativeSnapshot, cause);
  };

  const commitDirect = async (candidate, reason) => {
    const normalized = normalizeProjectSnapshot(candidate);
    const previous = activeSnapshot;
    setActive(normalized);

    try {
      const commit = validateCommit(
        await invokeCommand('project_commit', { snapshot: normalized, reason }),
        normalized.stateVersion
      );
      const committedSnapshot = setActive({
        ...normalized,
        stateVersion: commit.stateVersion,
      });
      return { ...commit, snapshot: committedSnapshot };
    } catch (error) {
      if (isStaleVersionError(error)) {
        return reloadAfterConflict(normalized.metadata.id, error);
      }
      setActive(previous);
      throw error;
    }
  };

  const ensureLoadedDirect = async (id) => {
    const projectId = validateProjectId(id);
    if (activeSnapshot?.metadata.id === projectId) {
      return normalizeProjectSnapshot(activeSnapshot);
    }
    const loaded = await loadDirect(projectId);
    if (loaded == null) {
      throw new ProjectServiceError('projectNotFound', 'The project does not exist', { projectId });
    }
    return loaded;
  };

  const create = (name) => {
    const projectName = validateProjectName(name);
    return enqueue(async () => setActive(
      await invokeCommand('project_create', { name: projectName })
    ));
  };

  const load = (id) => enqueue(() => loadDirect(id));

  const reload = (id = activeSnapshot?.metadata.id) => enqueue(() => {
    if (id == null) {
      throw new ProjectServiceError('noActiveProject', 'There is no active project to reload');
    }
    return loadDirect(id);
  });

  const commit = (snapshot, reason) => {
    // Copy at call time so a caller cannot mutate a queued revision by retaining an object alias.
    const candidate = normalizeProjectSnapshot(snapshot);
    const revisionReason = validateReason(reason);
    return enqueue(() => commitDirect(candidate, revisionReason));
  };

  const mutate = (projectId, reason, mutator, { retryOnConflict = false } = {}) => {
    validateProjectId(projectId);
    const revisionReason = validateReason(reason);
    if (typeof mutator !== 'function') {
      throw new ProjectServiceError('invalidProjectMutation', 'A project mutation function is required');
    }

    return enqueue(async () => {
      let snapshot = await ensureLoadedDirect(projectId);
      for (let attempt = 0; attempt < (retryOnConflict ? 2 : 1); attempt += 1) {
        const candidate = normalizeProjectSnapshot(await mutator(
          normalizeProjectSnapshot(snapshot)
        ));
        if (candidate.metadata.id !== projectId) {
          throw new ProjectServiceError(
            'crossProjectMutation',
            'A project mutation cannot change the project ID'
          );
        }
        if (candidate.stateVersion !== snapshot.stateVersion) {
          throw new ProjectServiceError(
            'invalidProjectMutation',
            'A project mutation cannot change the state version'
          );
        }
        if (JSON.stringify(candidate) === JSON.stringify(snapshot)) {
          return {
            revisionId: null,
            stateVersion: snapshot.stateVersion,
            snapshot: normalizeProjectSnapshot(snapshot),
            committed: false,
          };
        }

        try {
          return await commitDirect(candidate, revisionReason);
        } catch (error) {
          if (!(error instanceof ProjectConflictError) || !retryOnConflict || attempt > 0) {
            throw error;
          }
          if (error.authoritativeSnapshot == null) {
            throw new ProjectServiceError('projectNotFound', 'The project no longer exists', {
              projectId,
            });
          }
          snapshot = error.authoritativeSnapshot;
        }
      }
      throw new ProjectServiceError('projectCommitFailed', 'The project could not be committed');
    });
  };

  const navigate = (
    command,
    id = activeSnapshot?.metadata.id,
    expectedReason = null
  ) => enqueue(async () => {
    if (id == null) {
      throw new ProjectServiceError('noActiveProject', 'There is no active project');
    }
    if (expectedReason !== null) validateReason(expectedReason);
    const snapshot = await ensureLoadedDirect(id);
    try {
      const args = {
        id: snapshot.metadata.id,
        expectedVersion: snapshot.stateVersion,
      };
      if (expectedReason !== null) args.expectedReason = expectedReason;
      const result = await invokeCommand(command, args);
      return result == null ? null : setActive(result);
    } catch (error) {
      if (isStaleVersionError(error)) {
        return reloadAfterConflict(snapshot.metadata.id, error);
      }
      throw error;
    }
  });

  const historyStatus = (id = activeSnapshot?.metadata.id) => enqueue(async () => {
    if (id == null) {
      throw new ProjectServiceError('noActiveProject', 'There is no active project');
    }
    const snapshot = await ensureLoadedDirect(id);
    const status = normalizeHistoryStatus(await invokeCommand('project_history_status', {
      id: snapshot.metadata.id,
    }));
    if (status.stateVersion !== snapshot.stateVersion) {
      return reloadAfterConflict(snapshot.metadata.id, new ProjectServiceError(
        STALE_PROJECT_VERSION,
        'The project history changed while it was being inspected'
      ));
    }
    return status;
  });

  const trackHistoryStatus = (id, selector) => {
    const projectId = validateProjectId(id);
    const trackSelector = normalizeTrackSelector(selector);
    return enqueue(async () => {
      let snapshot = await ensureLoadedDirect(projectId);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const status = normalizeTrackHistoryStatus(await invokeCommand(
          'project_track_history_status',
          { id: projectId, selector: trackSelector }
        ));
        if (status.stateVersion === snapshot.stateVersion) return status;
        const loaded = await loadDirect(projectId);
        if (loaded === null) {
          throw new ProjectServiceError('projectNotFound', 'The project does not exist', {
            projectId,
          });
        }
        snapshot = loaded;
        if (status.stateVersion === snapshot.stateVersion) return status;
      }
      return reloadAfterConflict(projectId, new ProjectServiceError(
        STALE_PROJECT_VERSION,
        'The project changed while its editor history was being inspected'
      ));
    });
  };

  const validateTrackMutation = (value, projectId) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ProjectServiceError(
        'invalidProjectTrackMutation',
        'The desktop host returned an invalid project track mutation'
      );
    }
    const snapshot = normalizeProjectSnapshot(value.snapshot);
    const status = normalizeTrackHistoryStatus(value.status);
    if (snapshot.metadata.id !== projectId || status.stateVersion !== snapshot.stateVersion) {
      throw new ProjectServiceError(
        'invalidProjectTrackMutation',
        'The desktop host returned an inconsistent project track mutation'
      );
    }
    return { snapshot, status };
  };

  const reloadTrackConflict = async (projectId, cause) => {
    let authoritativeSnapshot = null;
    try {
      authoritativeSnapshot = await loadDirect(projectId);
    } catch (reloadError) {
      throw new ProjectServiceError(
        'projectReloadFailed',
        'The subtitle history conflicted and could not be reloaded',
        { projectId, cause, reloadError }
      );
    }
    throw new ProjectConflictError(projectId, authoritativeSnapshot, cause);
  };

  const commitTrack = ({
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
    return enqueue(async () => {
      await ensureLoadedDirect(projectId);
      try {
        const result = validateTrackMutation(await invokeCommand('project_track_commit', {
          id: projectId,
          selector: trackSelector,
          expectedHistoryVersion: historyVersion,
          beforeTrack: previous,
          afterTrack: next,
          reason: revisionReason,
        }), projectId);
        setActive(result.snapshot);
        return result;
      } catch (error) {
        if (TRACK_HISTORY_CONFLICT_CODES.has(error?.code)) {
          return reloadTrackConflict(projectId, error);
        }
        throw error;
      }
    });
  };

  const navigateTrack = (command, {
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
    return enqueue(async () => {
      await ensureLoadedDirect(projectId);
      try {
        const value = await invokeCommand(command, {
          id: projectId,
          selector: trackSelector,
          expectedHistoryVersion,
          expectedReason: reason,
        });
        if (value === null) return null;
        const result = validateTrackMutation(value, projectId);
        setActive(result.snapshot);
        return result;
      } catch (error) {
        if (TRACK_HISTORY_CONFLICT_CODES.has(error?.code)) {
          return reloadTrackConflict(projectId, error);
        }
        throw error;
      }
    });
  };

  const subscribe = (subscriber) => {
    if (typeof subscriber !== 'function') {
      throw new ProjectServiceError('invalidSubscriber', 'A subscriber function is required');
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  };

  return Object.freeze({
    createProject: create,
    loadProject: load,
    reloadProject: reload,
    commitProject: commit,
    mutateProject: mutate,
    getProjectHistoryStatus: historyStatus,
    getProjectTrackHistoryStatus: trackHistoryStatus,
    commitProjectTrack: commitTrack,
    undoProjectTrack: (options) => navigateTrack('project_track_undo', options),
    redoProjectTrack: (options) => navigateTrack('project_track_redo', options),
    undoProject: (id, expectedReason = null) => navigate('project_undo', id, expectedReason),
    redoProject: (id, expectedReason = null) => navigate('project_redo', id, expectedReason),
    getActiveProjectSnapshot: () => (
      activeSnapshot == null ? null : normalizeProjectSnapshot(activeSnapshot)
    ),
    subscribe,
  });
};

const projectService = createProjectService();

export const createProject = projectService.createProject;
export const loadProject = projectService.loadProject;
export const reloadProject = projectService.reloadProject;
export const commitProject = projectService.commitProject;
export const mutateProject = projectService.mutateProject;
export const getProjectHistoryStatus = projectService.getProjectHistoryStatus;
export const getProjectTrackHistoryStatus = projectService.getProjectTrackHistoryStatus;
export const commitProjectTrack = projectService.commitProjectTrack;
export const undoProjectTrack = projectService.undoProjectTrack;
export const redoProjectTrack = projectService.redoProjectTrack;
export const undoProject = projectService.undoProject;
export const redoProject = projectService.redoProject;
export const getActiveProjectSnapshot = projectService.getActiveProjectSnapshot;
export const subscribeToActiveProject = projectService.subscribe;
