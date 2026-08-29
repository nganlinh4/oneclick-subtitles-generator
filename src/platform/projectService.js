import { invokeDesktop } from './desktopRuntime';
import { isUuidV7, normalizeProjectSnapshot } from './projectSnapshotAdapter';

export const STALE_PROJECT_VERSION = 'staleProjectVersion';
export const PROJECT_COMMAND_OUTCOME_UNCERTAIN = 'projectCommandOutcomeUncertain';

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

const withCommandTimeout = (
  promise,
  command,
  timeoutMs,
  schedule,
  cancel,
  onTimeout = null
) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = schedule(() => {
      reject(onTimeout?.() ?? new ProjectServiceError(
        'projectCommandTimedOut',
        'The desktop host did not respond to a project command in time',
        { command }
      ));
    }, timeoutMs);
    promise.then(
      (value) => { cancel(timer); resolve(value); },
      (error) => { cancel(timer); reject(error); },
    );
  });
};

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
const MUTATING_PROJECT_COMMANDS = new Set([
  'project_commit',
  'project_undo',
  'project_redo',
  'project_track_commit',
  'project_track_undo',
  'project_track_redo',
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

const validateProjectCreateKey = (idempotencyKey) => {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0
      || idempotencyKey.length > 8_192
      || Array.from(idempotencyKey).some(character => /\p{Cc}/u.test(character))) {
    throw new ProjectServiceError(
      'invalidProjectCreateKey',
      'A bounded stable project create identity is required'
    );
  }
  return idempotencyKey;
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

const freezeTree = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeTree);
  return Object.freeze(value);
};

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
  const projectTails = new Map();
  const uncertainProjects = new Map();
  const inFlightProjectMutations = new Map();
  const synchronousMutatorFrames = [];
  const subscribers = new Set();
  const mutationStep = Symbol('mutationStep');

  const copySnapshot = (snapshot) => (
    snapshot == null ? null : freezeTree(normalizeProjectSnapshot(snapshot))
  );

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

  const uncertainOutcomeError = (projectId, state) => {
    const error = new ProjectServiceError(
      PROJECT_COMMAND_OUTCOME_UNCERTAIN,
      state.pending.size > 0
        ? 'A project command timed out and may still complete. Restart the desktop application before editing this project again.'
        : 'A project command completed after its timeout, but authoritative recovery has not succeeded.',
      {
        projectId,
        command: state.commands.at(-1) ?? null,
        pendingNativeCommands: state.pending.size,
        recoveryRequired: true,
        requiresDesktopRestart: state.pending.size > 0,
      }
    );
    // Higher layers may retry their own reconciliation after this resolves. It is deliberately
    // non-enumerable: this in-process coordination promise is not error evidence or transport data.
    Object.defineProperty(error, 'outcomeRecovery', {
      value: state.outcomeRecovery,
      enumerable: false,
    });
    return error;
  };

  const assertProjectCertain = (projectId) => {
    const state = uncertainProjects.get(projectId);
    if (state !== undefined) throw uncertainOutcomeError(projectId, state);
  };

  const beginNativeCall = (command, args) => {
    try {
      return Promise.resolve(invokeCommand(command, args));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const recoverUncertainProject = (projectId, state) => {
    if (uncertainProjects.get(projectId) !== state) {
      return Promise.resolve(copySnapshot(activeSnapshot));
    }
    if (state.pending.size > 0) return Promise.reject(uncertainOutcomeError(projectId, state));
    if (state.recovery !== null) return state.recovery;

    const expectedActivationGeneration = activationGeneration;
    const nativeLoad = beginNativeCall('project_load', { id: projectId });
    state.recovery = withCommandTimeout(
      nativeLoad,
      'project_load',
      commandTimeoutMs,
      schedule,
      cancel
    ).then((value) => {
      const snapshot = copySnapshot(value);
      if (snapshot !== null && snapshot.metadata.id !== projectId) {
        throw new ProjectServiceError(
          'invalidProjectLoad',
          'The desktop host returned a different project during uncertain-outcome recovery',
          { projectId, returnedProjectId: snapshot.metadata.id }
        );
      }
      if (uncertainProjects.get(projectId) === state && state.pending.size === 0) {
        uncertainProjects.delete(projectId);
        refreshActiveProject(projectId, snapshot, expectedActivationGeneration);
        state.resolveOutcomeRecovery(snapshot);
      }
      return snapshot;
    }).catch((error) => {
      state.recovery = null;
      state.recoveryError = error;
      throw error;
    });
    // Automatic recovery is best effort. Its rejection remains recorded on the latch and is
    // deliberately observed here; an explicit recovery call may safely retry the read later.
    void state.recovery.catch(() => undefined);
    return state.recovery;
  };

  const markProjectOutcomeUncertain = (projectId, command, nativeCall) => {
    let state = uncertainProjects.get(projectId);
    if (state === undefined) {
      let resolveOutcomeRecovery;
      const outcomeRecovery = new Promise((resolve) => {
        resolveOutcomeRecovery = resolve;
      });
      state = {
        commands: [],
        pending: new Set(),
        recovery: null,
        recoveryError: null,
        outcomeRecovery,
        resolveOutcomeRecovery,
      };
      uncertainProjects.set(projectId, state);
    }
    state.commands.push(command);
    const trackUncertainCall = (call) => {
      if (state.pending.has(call)) return;
      state.pending.add(call);
      const settled = () => {
        state.pending.delete(call);
        if (state.pending.size === 0 && uncertainProjects.get(projectId) === state) {
          void recoverUncertainProject(projectId, state).catch(() => undefined);
        }
      };
      call.then(settled, settled);
    };
    // A synchronous re-entrant mutator can already have more than one native CAS in flight when
    // the first watchdog fires. Every one of them is capable of committing later, even if its own
    // timeout has not fired yet, so the latch must wait for the whole in-flight set.
    const inFlight = inFlightProjectMutations.get(projectId);
    if (inFlight === undefined || inFlight.size === 0) {
      trackUncertainCall(nativeCall);
    } else {
      inFlight.forEach(trackUncertainCall);
    }
    return uncertainOutcomeError(projectId, state);
  };

  const invoke = (command, args, createTimeoutError = null) => {
    const projectId = MUTATING_PROJECT_COMMANDS.has(command)
      ? args?.id ?? args?.snapshot?.metadata?.id ?? null
      : null;
    if (projectId !== null) assertProjectCertain(projectId);
    const nativeCall = beginNativeCall(command, args);
    if (projectId !== null) {
      let inFlight = inFlightProjectMutations.get(projectId);
      if (inFlight === undefined) {
        inFlight = new Set();
        inFlightProjectMutations.set(projectId, inFlight);
      }
      inFlight.add(nativeCall);
      const retire = () => {
        inFlight.delete(nativeCall);
        if (inFlight.size === 0 && inFlightProjectMutations.get(projectId) === inFlight) {
          inFlightProjectMutations.delete(projectId);
        }
      };
      nativeCall.then(retire, retire);
    }
    const bounded = withCommandTimeout(
      nativeCall,
      command,
      commandTimeoutMs,
      schedule,
      cancel,
      projectId === null
        ? createTimeoutError
        : () => markProjectOutcomeUncertain(projectId, command, nativeCall)
    );
    if (projectId === null) return bounded;
    return bounded.then(
      (value) => {
        // Another concurrent same-project mutation may have timed out while this one was pending.
        // Its result cannot be published independently of the shared authoritative recovery.
        assertProjectCertain(projectId);
        return value;
      },
      (error) => {
        const state = uncertainProjects.get(projectId);
        if (state !== undefined && error?.code !== PROJECT_COMMAND_OUTCOME_UNCERTAIN) {
          throw uncertainOutcomeError(projectId, state);
        }
        throw error;
      }
    );
  };

  const enqueueProject = (projectId, operation) => {
    const guardedOperation = () => {
      assertProjectCertain(projectId);
      return operation();
    };
    const mutatorFrame = synchronousMutatorFrames[synchronousMutatorFrames.length - 1];
    if (mutatorFrame?.projectId === projectId) {
      mutatorFrame.reentered = true;
      try {
        return Promise.resolve(guardedOperation());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const previous = projectTails.get(projectId) ?? Promise.resolve();
    const result = previous.then(guardedOperation, guardedOperation);
    const recovered = result.catch(() => undefined);
    projectTails.set(projectId, recovered);
    void recovered.then(() => {
      if (projectTails.get(projectId) === recovered) projectTails.delete(projectId);
    });
    return result;
  };

  const invokeMutator = (projectId, mutator, snapshot) => {
    const frame = { projectId, reentered: false };
    synchronousMutatorFrames.push(frame);
    try {
      return { frame, value: mutator(copySnapshot(snapshot)) };
    } finally {
      synchronousMutatorFrames.pop();
    }
  };

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

  const recoverProjectCommandOutcome = (id) => {
    const projectId = validateProjectId(id);
    const state = uncertainProjects.get(projectId);
    if (state === undefined) return readDirect(projectId);
    return recoverUncertainProject(projectId, state);
  };

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

  const trackHistoryStatusDetached = (id, selector) => {
    const projectId = validateProjectId(id);
    const trackSelector = normalizeTrackSelector(selector);
    const expectedActivationGeneration = activationGeneration;
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
    const expectedActivationGeneration = activationGeneration;
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
    const expectedActivationGeneration = activationGeneration;
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

  const subscribe = (subscriber) => {
    if (typeof subscriber !== 'function') {
      throw new ProjectServiceError('invalidSubscriber', 'A subscriber function is required');
    }
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  };

  const undoDetachedTrack = (options) => (
    navigateTrackDetached('project_track_undo', options)
  );
  const redoDetachedTrack = (options) => (
    navigateTrackDetached('project_track_redo', options)
  );
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

export const readProject = projectService.readProject;
export const createDetachedProject = projectService.createDetachedProject;
export const commitDetachedProject = projectService.commitDetachedProject;
export const mutateDetachedProject = projectService.mutateDetachedProject;
export const getDetachedProjectHistoryStatus = projectService.getDetachedProjectHistoryStatus;
export const getDetachedProjectTrackHistoryStatus = (
  projectService.getDetachedProjectTrackHistoryStatus
);
export const commitDetachedProjectTrack = projectService.commitDetachedProjectTrack;
export const undoDetachedProjectTrack = projectService.undoDetachedProjectTrack;
export const redoDetachedProjectTrack = projectService.redoDetachedProjectTrack;
export const undoDetachedProject = projectService.undoDetachedProject;
export const redoDetachedProject = projectService.redoDetachedProject;
export const activateProjectSnapshot = projectService.activateProjectSnapshot;
export const activateProject = projectService.activateProject;
export const deactivateProject = projectService.deactivateProject;
export const recoverProjectCommandOutcome = projectService.recoverProjectCommandOutcome;

// Backward-compatible names intentionally retain detached storage semantics.
export const createProject = projectService.createProject;
export const loadProject = projectService.loadProject;
export const reloadProject = projectService.reloadProject;
export const recoverProjectOutcome = projectService.recoverProjectOutcome;
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
