import { invokeDesktop } from './desktopRuntime';
import { normalizeProjectSnapshot } from './projectSnapshotAdapter';
import { createProjectCommandGate } from './projectCommandGate';
import { createProjectTrackOperations } from './projectTrackOperations';
import {
  STALE_PROJECT_VERSION,
  ProjectConflictError,
  ProjectServiceError,
  copySnapshot,
  freezeTree,
  isStaleVersionError,
  normalizeHistoryStatus,
  validateCommit,
  validateProjectCreateKey,
  validateProjectId,
  validateProjectName,
  validateReason,
} from './projectServiceContract';

export { STALE_PROJECT_VERSION, ProjectConflictError };

/**
 * Every command this service issues is a bounded, database-backed request/response -- never a
 * blocking native dialog (those live in `mediaService.js`, which does not route through here).
 * `enqueueProject` serializes every durable operation for one project behind a single tail
 * promise, and that tail promise only advances when the operation it is waiting on settles. A
 * native reply that never arrives -- a lost IPC round trip, not a real rejection -- would
 * therefore stall every later operation on the same project forever, silently: no error to
 * catch, no toast, just an edit (for example the multi-cue range move) that never becomes
 * durable. A timeout alone cannot safely recover a mutating queue: `Promise.race` does not cancel
 * the native command, so Rust may still commit after JavaScript has observed the timeout. This
 * service therefore latches that project as uncertain, rejects dependent reads and writes, and
 * clears the latch only after the original native promise settles AND an authoritative load
 * succeeds. If the native promise never settles, only a full desktop-process restart can prove it
 * can no longer mutate the store.
 */
export const PROJECT_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Durable project command bridge. Storage operations are detached from the active-project
 * publication channel. Only explicit activation, or an authoritative operation result for the
 * project which is still active when that result completes, may publish to subscribers.
 */
export const createProjectService = ({
  invokeCommand = invokeDesktop,
  commandTimeoutMs = PROJECT_COMMAND_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) => {
  let activeSnapshot = null;
  let activationGeneration = 0;
  let activationRequestSequence = 0;
  let pendingActivation = null;
  let activePublicationVersion = 0;
  let pendingPublication = null;
  let publishing = false;
  const subscribers = new Set();
  const mutationStep = Symbol('mutationStep');

  const publish = (snapshot, version) => {
    // Coalesce synchronous re-entry to the newest active snapshot. The current publication stops
    // before another subscriber can observe an event which has already been superseded.
    pendingPublication = { snapshot, version };
    if (publishing) return;
    publishing = true;
    try {
      while (pendingPublication !== null) {
        const publication = pendingPublication;
        pendingPublication = null;
        const recipients = Array.from(subscribers);
        for (const subscriber of recipients) {
          if (publication.version !== activePublicationVersion) break;
          if (!subscribers.has(subscriber)) continue;
          try {
            subscriber(copySnapshot(publication.snapshot));
          } catch (error) {
            console.error('[projectService] Active-project subscriber failed:', error);
          }
        }
      }
    } finally {
      publishing = false;
    }
  };

  const replaceActive = (snapshot) => {
    const nextSnapshot = copySnapshot(snapshot);
    const returnSnapshot = copySnapshot(nextSnapshot);
    activeSnapshot = nextSnapshot;
    activePublicationVersion += 1;
    publish(nextSnapshot, activePublicationVersion);
    // A subscriber may have synchronously activated another project while publishing. This call
    // still returns the exact snapshot which it was asked to activate/refresh.
    return returnSnapshot;
  };

  const refreshActiveProject = (projectId, snapshot, expectedActivationGeneration) => {
    if (activationGeneration !== expectedActivationGeneration
        || activeSnapshot?.metadata.id !== projectId) return false;
    replaceActive(snapshot);
    return true;
  };

  const {
    assertProjectCertain,
    invoke,
    enqueueProject,
    invokeMutator,
    recoverOutcome,
  } = createProjectCommandGate({
    invokeCommand,
    commandTimeoutMs,
    schedule,
    cancel,
    getActiveSnapshot: () => activeSnapshot,
    getActivationGeneration: () => activationGeneration,
    refreshActiveProject,
  });

  const readDirect = async (id) => {
    const projectId = validateProjectId(id);
    assertProjectCertain(projectId);
    const snapshot = await invoke('project_load', { id: projectId });
    // A mutating command that was already in flight can time out while this read is awaiting its
    // reply. Returning that observation would let a caller reconcile against state which the late
    // mutation may still change, so check the latch on both sides of the native read.
    assertProjectCertain(projectId);
    const normalized = copySnapshot(snapshot);
    if (normalized !== null && normalized.metadata.id !== projectId) {
      throw new ProjectServiceError(
        'invalidProjectLoad',
        'The desktop host returned a different project than the one requested',
        { projectId, returnedProjectId: normalized.metadata.id }
      );
    }
    return normalized;
  };

  const requireProjectDirect = async (id) => {
    const projectId = validateProjectId(id);
    const snapshot = await readDirect(projectId);
    if (snapshot === null) {
      throw new ProjectServiceError('projectNotFound', 'The project does not exist', { projectId });
    }
    return snapshot;
  };

  const reloadAfterConflict = async (
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
        'The project conflicted and could not be reloaded',
        { projectId, cause, reloadError }
      );
    }
    refreshActiveProject(projectId, authoritativeSnapshot, expectedActivationGeneration);
    throw new ProjectConflictError(projectId, authoritativeSnapshot, cause);
  };

  const commitDirect = async (candidate, reason, expectedActivationGeneration) => {
    const normalized = copySnapshot(candidate);
    try {
      const commit = validateCommit(
        await invoke('project_commit', { snapshot: normalized, reason }),
        normalized.stateVersion
      );
      const committedSnapshot = copySnapshot({
        ...normalized,
        stateVersion: commit.stateVersion,
      });
      refreshActiveProject(
        normalized.metadata.id,
        committedSnapshot,
        expectedActivationGeneration
      );
      return freezeTree({ ...commit, snapshot: committedSnapshot });
    } catch (error) {
      if (isStaleVersionError(error)) {
        return reloadAfterConflict(
          normalized.metadata.id,
          error,
          expectedActivationGeneration
        );
      }
      throw error;
    }
  };

  const read = (id) => {
    const projectId = validateProjectId(id);
    return readDirect(projectId);
  };

  const createDetached = (name, idempotencyKey) => {
    const projectName = validateProjectName(name);
    const createKey = validateProjectCreateKey(idempotencyKey);
    return Promise.resolve().then(async () => copySnapshot(
      await invoke(
        'project_create',
        { name: projectName, idempotencyKey: createKey },
        () => new ProjectServiceError(
          'projectCommandTimedOut',
          'The desktop host did not respond to a project command in time. Retrying this create identity is safe.',
          {
            command: 'project_create',
            idempotencyKey: createKey,
            retrySafe: true,
          }
        )
      )
    ));
  };

  const reloadDetached = async (id = activeSnapshot?.metadata.id) => {
    if (id == null) {
      throw new ProjectServiceError('noActiveProject', 'There is no active project to reload');
    }
    return readDirect(id);
  };

  const recoverProjectCommandOutcome = (id) => recoverOutcome(validateProjectId(id), readDirect);

  const activateSnapshot = (snapshot) => {
    const normalized = normalizeProjectSnapshot(snapshot);
    activationGeneration += 1;
    activationRequestSequence += 1;
    pendingActivation = null;
    return replaceActive(normalized);
  };

  const activate = (id) => {
    const projectId = validateProjectId(id);
    const requestId = activationRequestSequence + 1;
    activationRequestSequence = requestId;
    activationGeneration += 1;
    pendingActivation = { projectId, requestId };
    return (async () => {
      try {
        const snapshot = await readDirect(projectId);
        // A later explicit activation/deactivation wins even if this load finishes last.
        if (snapshot !== null
            && activationRequestSequence === requestId
            && pendingActivation?.requestId === requestId) {
          pendingActivation = null;
          activationGeneration += 1;
          replaceActive(snapshot);
        }
        return snapshot;
      } finally {
        if (pendingActivation?.requestId === requestId) pendingActivation = null;
      }
    })();
  };

  const deactivate = (options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new ProjectServiceError(
        'invalidProjectDeactivation',
        'Project deactivation options are invalid'
      );
    }
    const { expectedProjectId } = options;
    if (expectedProjectId !== undefined) validateProjectId(expectedProjectId);
    const activeMatches = expectedProjectId === undefined
      || activeSnapshot?.metadata.id === expectedProjectId;
    const pendingMatches = expectedProjectId === undefined
      ? pendingActivation !== null
      : pendingActivation?.projectId === expectedProjectId;
    if (expectedProjectId !== undefined && !activeMatches && !pendingMatches) {
      return false;
    }
    activationGeneration += 1;
    if (pendingMatches) {
      activationRequestSequence += 1;
      pendingActivation = null;
    }
    if (activeMatches && activeSnapshot !== null) replaceActive(null);
    return true;
  };

  const commitDetached = (snapshot, reason) => {
    // Copy at call time so a caller cannot mutate a queued revision by retaining an object alias.
    const candidate = normalizeProjectSnapshot(snapshot);
    const revisionReason = validateReason(reason);
    const expectedActivationGeneration = activationGeneration;
    return enqueueProject(candidate.metadata.id, () => commitDirect(
      candidate,
      revisionReason,
      expectedActivationGeneration
    ));
  };

  const mutateDetached = (projectId, reason, mutator, { retryOnConflict = false } = {}) => {
    validateProjectId(projectId);
    const revisionReason = validateReason(reason);
    const expectedActivationGeneration = activationGeneration;
    if (typeof mutator !== 'function') {
      throw new ProjectServiceError('invalidProjectMutation', 'A project mutation function is required');
    }

    const finishCandidate = async (snapshot, rawCandidate, attempt) => {
      const candidate = normalizeProjectSnapshot(rawCandidate);
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
        // An asynchronous/re-entrant mutator may have allowed a child operation to commit after
        // this attempt loaded. Re-read instead of publishing or returning the pre-child snapshot.
        const authoritativeSnapshot = await requireProjectDirect(projectId);
        refreshActiveProject(
          projectId,
          authoritativeSnapshot,
          expectedActivationGeneration
        );
        return freezeTree({
          revisionId: null,
          stateVersion: authoritativeSnapshot.stateVersion,
          snapshot: copySnapshot(authoritativeSnapshot),
          committed: false,
        });
      }

      try {
        return await commitDirect(
          candidate,
          revisionReason,
          expectedActivationGeneration
        );
      } catch (error) {
        if (!(error instanceof ProjectConflictError)
            || !retryOnConflict || attempt > 0) {
          throw error;
        }
        if (error.authoritativeSnapshot == null) {
          throw new ProjectServiceError('projectNotFound', 'The project no longer exists', {
            projectId,
          });
        }
        return {
          [mutationStep]: 'retry',
          attempt: attempt + 1,
          snapshot: error.authoritativeSnapshot,
        };
      }
    };

    const beginAttempt = async (snapshot, attempt) => {
      const current = snapshot ?? await requireProjectDirect(projectId);
      const { value } = invokeMutator(projectId, mutator, current);
      if (value !== null
          && (typeof value === 'object' || typeof value === 'function')
          && typeof value.then === 'function') {
        // Do not hold the per-project FIFO while awaiting arbitrary application code. Child or
        // external same-project operations can settle; the candidate later commits with CAS.
        return {
          [mutationStep]: 'awaitCandidate',
          attempt,
          candidate: Promise.resolve(value),
          snapshot: current,
        };
      }
      return finishCandidate(current, value, attempt);
    };

    const driveMutation = async (initialStep) => {
      let step = await initialStep;
      while (step?.[mutationStep]) {
        if (step[mutationStep] === 'awaitCandidate') {
          const { attempt, candidate: pendingCandidate, snapshot } = step;
          const candidate = await pendingCandidate;
          step = await enqueueProject(projectId, () => finishCandidate(
            snapshot,
            candidate,
            attempt
          ));
        } else {
          const { attempt, snapshot } = step;
          step = await enqueueProject(projectId, () => beginAttempt(
            snapshot,
            attempt
          ));
        }
      }
      return step;
    };

    return driveMutation(enqueueProject(projectId, () => beginAttempt(null, 0)));
  };

  const navigateDetached = (
    command,
    id = activeSnapshot?.metadata.id,
    expectedReason = null
  ) => {
    if (id == null) {
      return Promise.reject(
        new ProjectServiceError('noActiveProject', 'There is no active project')
      );
    }
    const projectId = validateProjectId(id);
    const expectedActivationGeneration = activationGeneration;
    return enqueueProject(projectId, async () => {
      if (expectedReason !== null) validateReason(expectedReason);
      const snapshot = await requireProjectDirect(projectId);
      try {
        const args = {
          id: snapshot.metadata.id,
          expectedVersion: snapshot.stateVersion,
        };
        if (expectedReason !== null) args.expectedReason = expectedReason;
        const value = await invoke(command, args);
        if (value === null) {
          refreshActiveProject(projectId, snapshot, expectedActivationGeneration);
          return null;
        }
        const result = copySnapshot(value);
        if (result.metadata.id !== snapshot.metadata.id) {
          throw new ProjectServiceError(
            'invalidProjectNavigation',
            'The desktop host returned a project from a different navigation target'
          );
        }
        refreshActiveProject(
          snapshot.metadata.id,
          result,
          expectedActivationGeneration
        );
        return result;
      } catch (error) {
        if (isStaleVersionError(error)) {
          return reloadAfterConflict(
            snapshot.metadata.id,
            error,
            expectedActivationGeneration
          );
        }
        throw error;
      }
    });
  };

  const historyStatusDetached = (id = activeSnapshot?.metadata.id) => {
    if (id == null) {
      return Promise.reject(
        new ProjectServiceError('noActiveProject', 'There is no active project')
      );
    }
    const projectId = validateProjectId(id);
    const expectedActivationGeneration = activationGeneration;
    return enqueueProject(projectId, async () => {
      const snapshot = await requireProjectDirect(projectId);
      const status = normalizeHistoryStatus(await invoke('project_history_status', {
        id: snapshot.metadata.id,
      }));
      if (status.stateVersion !== snapshot.stateVersion) {
        return reloadAfterConflict(
          snapshot.metadata.id,
          new ProjectServiceError(
            STALE_PROJECT_VERSION,
            'The project history changed while it was being inspected'
          ),
          expectedActivationGeneration
        );
      }
      refreshActiveProject(projectId, snapshot, expectedActivationGeneration);
      return status;
    });
  };

  const {
    trackHistoryStatusDetached,
    commitTrackDetached,
    undoDetachedTrack,
    redoDetachedTrack,
  } = createProjectTrackOperations({
    enqueueProject,
    invoke,
    readDirect,
    requireProjectDirect,
    reloadAfterConflict,
    refreshActiveProject,
    getActivationGeneration: () => activationGeneration,
  });

  const subscribe = (subscriber) => {
    if (typeof subscriber !== 'function') {
      throw new ProjectServiceError('invalidSubscriber', 'A subscriber function is required');
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  };

  const undoDetached = (id, expectedReason = null) => (
    navigateDetached('project_undo', id, expectedReason)
  );
  const redoDetached = (id, expectedReason = null) => (
    navigateDetached('project_redo', id, expectedReason)
  );

  return Object.freeze({
    readProject: read,
    createDetachedProject: createDetached,
    commitDetachedProject: commitDetached,
    mutateDetachedProject: mutateDetached,
    getDetachedProjectHistoryStatus: historyStatusDetached,
    getDetachedProjectTrackHistoryStatus: trackHistoryStatusDetached,
    commitDetachedProjectTrack: commitTrackDetached,
    undoDetachedProjectTrack: undoDetachedTrack,
    redoDetachedProjectTrack: redoDetachedTrack,
    undoDetachedProject: undoDetached,
    redoDetachedProject: redoDetached,
    activateProjectSnapshot: activateSnapshot,
    activateProject: activate,
    deactivateProject: deactivate,
    recoverProjectCommandOutcome,

    // Compatibility APIs are deliberately detached. Existing storage callers must not acquire
    // global active-project authority merely by creating, reading, or editing a project.
    createProject: createDetached,
    loadProject: read,
    reloadProject: reloadDetached,
    recoverProjectOutcome: recoverProjectCommandOutcome,
    commitProject: commitDetached,
    mutateProject: mutateDetached,
    getProjectHistoryStatus: historyStatusDetached,
    getProjectTrackHistoryStatus: trackHistoryStatusDetached,
    commitProjectTrack: commitTrackDetached,
    undoProjectTrack: undoDetachedTrack,
    redoProjectTrack: redoDetachedTrack,
    undoProject: undoDetached,
    redoProject: redoDetached,
    getActiveProjectSnapshot: () => copySnapshot(activeSnapshot),
    subscribe,
  });
};

const projectService = createProjectService();

export const undoDetachedProject = projectService.undoDetachedProject;
export const activateProjectSnapshot = projectService.activateProjectSnapshot;
export const deactivateProject = projectService.deactivateProject;

// Backward-compatible names intentionally retain detached storage semantics.
export const createProject = projectService.createProject;
export const loadProject = projectService.loadProject;
export const mutateProject = projectService.mutateProject;
export const getProjectTrackHistoryStatus = projectService.getProjectTrackHistoryStatus;
export const commitProjectTrack = projectService.commitProjectTrack;
export const undoProjectTrack = projectService.undoProjectTrack;
export const redoProjectTrack = projectService.redoProjectTrack;
export const getActiveProjectSnapshot = projectService.getActiveProjectSnapshot;
export const subscribeToActiveProject = projectService.subscribe;
