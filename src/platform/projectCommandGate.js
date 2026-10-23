// The project command gate: every native project command is bounded by a timeout, mutating
// commands for one project run behind a single FIFO tail, and a timed-out mutation latches its
// project as outcome-uncertain until an authoritative reload proves the store again. See the
// PROJECT_COMMAND_TIMEOUT_MS note in projectService.js for why a timeout alone is not enough.
import {
  MUTATING_PROJECT_COMMANDS,
  PROJECT_COMMAND_OUTCOME_UNCERTAIN,
  ProjectServiceError,
  copySnapshot,
} from './projectServiceContract';

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

export const createProjectCommandGate = ({
  invokeCommand,
  commandTimeoutMs,
  schedule,
  cancel,
  getActiveSnapshot,
  getActivationGeneration,
  refreshActiveProject,
}) => {
  const projectTails = new Map();
  const uncertainProjects = new Map();
  const inFlightProjectMutations = new Map();
  const synchronousMutatorFrames = [];

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
      return Promise.resolve(copySnapshot(getActiveSnapshot()));
    }
    if (state.pending.size > 0) return Promise.reject(uncertainOutcomeError(projectId, state));
    if (state.recovery !== null) return state.recovery;

    const expectedActivationGeneration = getActivationGeneration();
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

  const recoverOutcome = (projectId, readDirect) => {
    const state = uncertainProjects.get(projectId);
    if (state === undefined) return readDirect(projectId);
    return recoverUncertainProject(projectId, state);
  };

  return Object.freeze({
    assertProjectCertain,
    invoke,
    enqueueProject,
    invokeMutator,
    recoverOutcome,
  });
};
