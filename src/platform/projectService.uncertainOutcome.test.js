// projectService: the outcome-uncertain latch after a timed-out mutating command.

import { createProjectService, PROJECT_COMMAND_TIMEOUT_MS, STALE_PROJECT_VERSION } from './projectService';
import {
  PROJECT_ID,
  REVISION_ONE,
  TRACK_SELECTOR,
  snapshot,
  track,
  trackStatus,
  deferred,
} from './projectServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

it('latches an uncertain late track commit, rejects queued reconciliation, and resumes only after authoritative recovery', async () => {
  vi.useFakeTimers();
  try {
    const lateCommit = deferred();
    const recoveryLoad = deferred();
    let trackCommitCalls = 0;
    let loadCalls = 0;
    let historyStatusCalls = 0;
    const firstCommitted = { ...snapshot(8), tracks: [track('After')] };
    const secondCommitted = { ...snapshot(8), tracks: [track('Second')] };
    secondCommitted.stateVersion = 9;
    const invokeCommand = vi.fn((command) => {
      if (command === 'project_load') {
        loadCalls += 1;
        if (loadCalls === 1) return Promise.resolve(snapshot(7));
        if (loadCalls === 2) return recoveryLoad.promise;
        return Promise.resolve(firstCommitted);
      }
      if (command === 'project_track_commit') {
        trackCommitCalls += 1;
        if (trackCommitCalls === 1) return lateCommit.promise;
        return Promise.resolve({
          snapshot: secondCommitted,
          status: trackStatus(9, 5, 'OSG lyrics editor v1: move range'),
        });
      }
      if (command === 'project_track_history_status') {
        historyStatusCalls += 1;
        return Promise.resolve(trackStatus(8, 4, 'OSG lyrics editor v1: text'));
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    service.activateProjectSnapshot(snapshot(7));

    const stuckCommit = service.commitProjectTrack({
      id: PROJECT_ID,
      selector: TRACK_SELECTOR,
      expectedHistoryVersion: 3,
      beforeTrack: track('Before'),
      afterTrack: track('After'),
      reason: 'OSG lyrics editor v1: text',
    });
    // Both calls enter the FIFO before the timeout. They must still re-check the uncertainty latch
    // when their turn arrives rather than running against whichever side of the late commit they
    // happen to observe.
    const laterCommit = service.commitProjectTrack({
      id: PROJECT_ID,
      selector: TRACK_SELECTOR,
      expectedHistoryVersion: 4,
      beforeTrack: track('After'),
      afterTrack: track('Second'),
      reason: 'OSG lyrics editor v1: move range',
    });
    const queuedStatus = service.getProjectTrackHistoryStatus(PROJECT_ID, TRACK_SELECTOR);

    await vi.waitFor(() => expect(trackCommitCalls).toBe(1));

    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);

    await expect(stuckCommit).rejects.toMatchObject({
      name: 'ProjectServiceError',
      code: 'projectCommandOutcomeUncertain',
      command: 'project_track_commit',
      projectId: PROJECT_ID,
      pendingNativeCommands: 1,
      requiresDesktopRestart: true,
    });
    await expect(laterCommit).rejects.toMatchObject({ code: 'projectCommandOutcomeUncertain' });
    await expect(queuedStatus).rejects.toMatchObject({ code: 'projectCommandOutcomeUncertain' });
    await expect(service.loadProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
    });
    await expect(service.recoverProjectOutcome(PROJECT_ID)).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
      requiresDesktopRestart: true,
    });
    expect(trackCommitCalls).toBe(1);
    expect(historyStatusCalls).toBe(0);
    expect(loadCalls).toBe(1);

    // Rust eventually reports that the timed-out mutation did commit. Only now may recovery read
    // the authoritative project; operations remain latched while that read is unresolved.
    lateCommit.resolve({
      snapshot: firstCommitted,
      status: trackStatus(8, 4, 'OSG lyrics editor v1: text'),
    });
    await vi.waitFor(() => expect(loadCalls).toBe(2));
    const recovering = service.recoverProjectOutcome(PROJECT_ID);
    await expect(service.loadProject(PROJECT_ID)).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
      pendingNativeCommands: 0,
      requiresDesktopRestart: false,
    });
    recoveryLoad.resolve(firstCommitted);
    await expect(recovering).resolves.toEqual(firstCommitted);
    expect(service.getActiveProjectSnapshot()).toEqual(firstCommitted);

    // The rejected dependent edit is never replayed implicitly. An explicit retry starts only
    // after the authoritative load and uses the recovered history version.
    await expect(service.commitProjectTrack({
      id: PROJECT_ID,
      selector: TRACK_SELECTOR,
      expectedHistoryVersion: 4,
      beforeTrack: track('After'),
      afterTrack: track('Second'),
      reason: 'OSG lyrics editor v1: move range',
    })).resolves.toMatchObject({ snapshot: secondCommitted });
    expect(trackCommitCalls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the timeout result uncertain when native success arrives before its rejection is observed', async () => {
  vi.useFakeTimers();
  try {
    const lateCommit = deferred();
    const authoritative = snapshot(8, 'Authoritative late success');
    const invokeCommand = vi.fn((command) => {
      if (command === 'project_commit') return lateCommit.promise;
      if (command === 'project_load') return Promise.resolve(authoritative);
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    service.activateProjectSnapshot(snapshot(7));
    const pending = service.commitProject(snapshot(7, 'Optimistic'), 'late success');
    const timeoutAssertion = expect(pending).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
    });
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
      'project_commit',
      expect.anything()
    ));

    // Fire the watchdog, then settle the native promise before awaiting the already-attached
    // rejection assertion. The late success must recover authority, never turn the call green.
    vi.advanceTimersByTime(PROJECT_COMMAND_TIMEOUT_MS);
    lateCommit.resolve({ revisionId: REVISION_ONE, stateVersion: 8 });
    await timeoutAssertion;
    await vi.waitFor(() => expect(service.getActiveProjectSnapshot()).toEqual(authoritative));
    expect(invokeCommand.mock.calls.map(([command]) => command)).toEqual([
      'project_commit',
      'project_load',
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it('requires a new desktop-host session when an uncertain native mutation never settles', async () => {
  vi.useFakeTimers();
  try {
    const oldHost = vi.fn((command) => {
      if (command === 'project_commit') return new Promise(() => undefined);
      throw new Error(`The latched host must not receive ${command}`);
    });
    const oldService = createProjectService({ invokeCommand: oldHost });
    oldService.activateProjectSnapshot(snapshot(4));
    const pending = oldService.commitProject(snapshot(4, 'Uncertain'), 'uncertain restart');
    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);
    await expect(pending).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
      requiresDesktopRestart: true,
    });
    await expect(oldService.recoverProjectOutcome(PROJECT_ID)).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
      requiresDesktopRestart: true,
    });
    await expect(oldService.getProjectHistoryStatus(PROJECT_ID)).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
    });
    expect(oldHost).toHaveBeenCalledTimes(1);

    // Re-instantiation is safe only because this service is explicitly bound to a different,
    // restarted desktop host: the old Rust process (and therefore its pending command) is gone.
    const restartedHost = vi.fn(async (command) => {
      if (command === 'project_load') return snapshot(5, 'Restart authority');
      throw new Error(`Unexpected command: ${command}`);
    });
    const restartedService = createProjectService({ invokeCommand: restartedHost });
    await expect(restartedService.loadProject(PROJECT_ID)).resolves.toEqual(
      snapshot(5, 'Restart authority')
    );
  } finally {
    vi.useRealTimers();
  }
});

it('keeps the latch closed after a failed authoritative load and permits an explicit safe retry', async () => {
  vi.useFakeTimers();
  try {
    const lateCommit = deferred();
    let loadCalls = 0;
    const authoritative = snapshot(6, 'Recovered on retry');
    const invokeCommand = vi.fn((command) => {
      if (command === 'project_commit') return lateCommit.promise;
      if (command === 'project_load') {
        loadCalls += 1;
        return loadCalls === 1
          ? Promise.reject(new Error('temporary read failure'))
          : Promise.resolve(authoritative);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    service.activateProjectSnapshot(snapshot(5));
    const pending = service.commitProject(snapshot(5, 'Optimistic'), 'recovery retry');
    await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
      'project_commit',
      expect.anything()
    ));
    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);
    await expect(pending).rejects.toMatchObject({ code: 'projectCommandOutcomeUncertain' });

    lateCommit.resolve({ revisionId: REVISION_ONE, stateVersion: 6 });
    await vi.waitFor(() => expect(loadCalls).toBe(1));
    await vi.waitFor(async () => {
      await expect(service.loadProject(PROJECT_ID)).rejects.toMatchObject({
        code: 'projectCommandOutcomeUncertain',
        pendingNativeCommands: 0,
        requiresDesktopRestart: false,
      });
    });
    await expect(service.recoverProjectOutcome(PROJECT_ID)).resolves.toEqual(authoritative);
    expect(loadCalls).toBe(2);
    expect(service.getActiveProjectSnapshot()).toEqual(authoritative);
  } finally {
    vi.useRealTimers();
  }
});

it('waits for every already-in-flight re-entrant mutation before authoritative recovery', async () => {
  vi.useFakeTimers();
  try {
    const nestedNative = deferred();
    const outerNative = deferred();
    let commitCalls = 0;
    let loadCalls = 0;
    const authoritative = snapshot(1, 'Nested won');
    const invokeCommand = vi.fn((command) => {
      if (command === 'project_load') {
        loadCalls += 1;
        return Promise.resolve(loadCalls === 1 ? snapshot() : authoritative);
      }
      if (command === 'project_commit') {
        commitCalls += 1;
        return commitCalls === 1 ? nestedNative.promise : outerNative.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    service.activateProjectSnapshot(snapshot());
    let nested;
    const outer = service.mutateProject(PROJECT_ID, 'outer re-entrant edit', (current) => {
      nested = service.commitProject({
        ...current,
        metadata: { ...current.metadata, name: 'Nested won' },
      }, 'nested re-entrant edit');
      // Stagger the watchdogs: the nested native CAS has already started, while the outer CAS is
      // not issued until this synchronous mutator returns.
      vi.advanceTimersByTime(PROJECT_COMMAND_TIMEOUT_MS / 2);
      return { ...current, metadata: { ...current.metadata, name: 'Outer lost' } };
    });
    await vi.waitFor(() => expect(commitCalls).toBe(2));
    const nestedTimeout = expect(nested).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
      pendingNativeCommands: 2,
    });

    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS / 2);
    await nestedTimeout;
    nestedNative.resolve({ revisionId: REVISION_ONE, stateVersion: 1 });
    await Promise.resolve();
    expect(loadCalls).toBe(1);

    // The other native CAS had not reached its own watchdog, but it was already capable of a late
    // mutation and therefore belongs to the same latch. Its stale rejection retires the last
    // uncertain writer; only then may the authoritative load run.
    const outerUncertain = expect(outer).rejects.toMatchObject({
      code: 'projectCommandOutcomeUncertain',
    });
    outerNative.reject({ code: STALE_PROJECT_VERSION });
    await outerUncertain;
    await vi.waitFor(() => expect(loadCalls).toBe(2));
    await vi.waitFor(() => expect(service.getActiveProjectSnapshot()).toEqual(authoritative));
  } finally {
    vi.useRealTimers();
  }
});
