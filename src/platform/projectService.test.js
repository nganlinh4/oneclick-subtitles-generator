import {
  createProjectService,
  PROJECT_COMMAND_TIMEOUT_MS,
  ProjectConflictError,
} from './projectService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PROJECT_B_ID = '01890f39-7b62-7c4e-8c9a-000000000201';
const PROJECT_C_ID = '01890f39-7b62-7c4e-8c9a-000000000301';
const REVISION_ONE = '01890f39-7b62-7c4e-8c9a-000000000102';
const REVISION_TWO = '01890f39-7b62-7c4e-8c9a-000000000103';
const REVISION_THREE = '01890f39-7b62-7c4e-8c9a-000000000106';
const TRACK_ID = '01890f39-7b62-7c4e-8c9a-000000000104';
const CUE_ID = '01890f39-7b62-7c4e-8c9a-000000000105';
const TRACK_SELECTOR = Object.freeze({ label: 'Cached subtitles', origin: 'legacyJson' });

const snapshotFor = (id, stateVersion = 0, name = 'Example') => ({
  metadata: { id, name },
  stateVersion,
  media: [],
  tracks: [],
});
const snapshot = (stateVersion = 0, name = 'Example') => (
  snapshotFor(PROJECT_ID, stateVersion, name)
);
const snapshotB = (stateVersion = 0, name = 'Project B') => (
  snapshotFor(PROJECT_B_ID, stateVersion, name)
);
const track = (text) => ({
  id: TRACK_ID,
  label: TRACK_SELECTOR.label,
  origin: TRACK_SELECTOR.origin,
  cues: [{
    id: CUE_ID,
    ordinal: 1,
    startMs: 0,
    endMs: 1_000,
    text,
    sourceId: null,
  }],
});
const trackStatus = (stateVersion, historyVersion, undoReason = null, redoReason = null) => ({
  stateVersion,
  historyVersion,
  diverged: false,
  canUndo: undoReason !== null,
  canRedo: redoReason !== null,
  undoReason,
  redoReason,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

it('bridges detached create and read using the exact Tauri argument contract', async () => {
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot(2));
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshotB());
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  await expect(service.createDetachedProject('Example')).resolves.toEqual(snapshot());
  await expect(service.readProject(PROJECT_ID)).resolves.toEqual(snapshot(2));
  expect(invokeCommand.mock.calls).toEqual([
    ['project_create', { name: 'Example' }],
    ['project_load', { id: PROJECT_ID }],
  ]);
  expect(service.createProject).toBe(service.createDetachedProject);
  expect(service.loadProject).toBe(service.readProject);
  expect(service.mutateProject).toBe(service.mutateDetachedProject);
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB());
  expect(subscriber).not.toHaveBeenCalled();
});

it('serializes detached mutations without optimistic publication', async () => {
  const firstCommit = deferred();
  const committedSnapshots = [];
  let storedSnapshot = snapshot();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') return storedSnapshot;
    if (command === 'project_commit') {
      committedSnapshots.push(args.snapshot);
      if (committedSnapshots.length === 1) {
        const result = await firstCommit.promise;
        storedSnapshot = { ...args.snapshot, stateVersion: result.stateVersion };
        return result;
      }
      storedSnapshot = { ...args.snapshot, stateVersion: 2 };
      return { revisionId: REVISION_TWO, stateVersion: 2 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  const first = service.mutateProject(PROJECT_ID, 'First edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'First' },
  }));
  const second = service.mutateProject(PROJECT_ID, 'Second edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Second' },
  }));

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(committedSnapshots).toHaveLength(1);
  expect(service.getActiveProjectSnapshot().metadata.name).toBe('Example');

  firstCommit.resolve({ revisionId: REVISION_ONE, stateVersion: 1 });
  await expect(first).resolves.toMatchObject({ stateVersion: 1 });
  await expect(second).resolves.toMatchObject({ stateVersion: 2 });

  expect(committedSnapshots.map((candidate) => ({
    name: candidate.metadata.name,
    stateVersion: candidate.stateVersion,
  }))).toEqual([
    { name: 'First', stateVersion: 0 },
    { name: 'Second', stateVersion: 1 },
  ]);
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(2, 'Second'));
});

it('does not create a revision when a canonical mutation is a no-op', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(3, 'Same');
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot(2, 'Stale active'));
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  const noOpResult = await service.mutateProject(
    PROJECT_ID,
    'No-op save',
    (current) => current,
  );
  expect(noOpResult).toEqual({
    revisionId: null,
    stateVersion: 3,
    snapshot: snapshot(3, 'Same'),
    committed: false,
  });
  expect(Object.isFrozen(noOpResult)).toBe(true);
  expect(invokeCommand).not.toHaveBeenCalledWith('project_commit', expect.anything());
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(3, 'Same'));
  expect(subscriber).toHaveBeenCalledWith(snapshot(3, 'Same'));
});

it('reloads authoritative state on conflict and recovers the queue for later work', async () => {
  let loadCount = 0;
  let commitCount = 0;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return loadCount <= 2 ? snapshot() : snapshot(4, 'External edit');
    }
    if (command === 'project_commit') {
      commitCount += 1;
      if (commitCount === 1) {
        throw { code: 'staleProjectVersion', message: 'stale' };
      }
      return { revisionId: REVISION_TWO, stateVersion: 5 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  await expect(service.mutateProject(PROJECT_ID, 'Conflicting edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Local edit' },
  }))).rejects.toEqual(expect.objectContaining({
    name: 'ProjectConflictError',
    code: 'staleProjectVersion',
    authoritativeSnapshot: snapshot(4, 'External edit'),
  }));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(4, 'External edit'));

  await expect(service.mutateProject(PROJECT_ID, 'Recovered edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Recovered' },
  }))).resolves.toMatchObject({ stateVersion: 5 });
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(5, 'Recovered'));
});

it('can reapply a pure mutation once after a conflict', async () => {
  let loadCount = 0;
  let commitCount = 0;
  const committedSnapshots = [];
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') {
      loadCount += 1;
      return loadCount === 1 ? snapshot() : snapshot(2, 'External');
    }
    if (command === 'project_commit') {
      commitCount += 1;
      committedSnapshots.push(args.snapshot);
      if (commitCount === 1) {
        throw { code: 'staleProjectVersion' };
      }
      return { revisionId: REVISION_TWO, stateVersion: 3 };
    }
    return null;
  });
  const service = createProjectService({ invokeCommand });

  await expect(service.mutateProject(
    PROJECT_ID,
    'Retry edit',
    (current) => ({ ...current, metadata: { ...current.metadata, name: 'Local wins this field' } }),
    { retryOnConflict: true }
  )).resolves.toMatchObject({ stateVersion: 3 });
  expect(committedSnapshots[1]).toEqual(snapshot(2, 'Local wins this field'));
});

it('sends authoritative versions for detached undo and redo and accepts empty results', async () => {
  let storedSnapshot = snapshot(6);
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return storedSnapshot;
    if (command === 'project_undo') {
      storedSnapshot = snapshot(7, 'Undone');
      return storedSnapshot;
    }
    if (command === 'project_redo') return null;
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  await expect(service.undoProject()).resolves.toEqual(snapshot(7, 'Undone'));
  await expect(service.redoProject()).resolves.toBeNull();
  expect(invokeCommand).toHaveBeenCalledWith('project_undo', {
    id: PROJECT_ID,
    expectedVersion: 6,
  });
  expect(invokeCommand).toHaveBeenCalledWith('project_redo', {
    id: PROJECT_ID,
    expectedVersion: 7,
  });
});

it('passes a bounded revision-reason guard for atomic editor navigation', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(4);
    if (command === 'project_undo') return snapshot(5, 'Undone');
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  await service.undoProject(PROJECT_ID, 'OSG lyrics editor v1: text');
  expect(invokeCommand).toHaveBeenLastCalledWith('project_undo', {
    id: PROJECT_ID,
    expectedVersion: 4,
    expectedReason: 'OSG lyrics editor v1: text',
  });
  await expect(service.redoProject(PROJECT_ID, 'forged\nreason')).rejects.toMatchObject({
    code: 'invalidRevisionReason',
  });
});

it('validates bounded history status and detects a cursor that raced the loaded snapshot', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(6, 'Loaded');
    if (command === 'project_history_status') {
      return {
        stateVersion: 6,
        canUndo: true,
        canRedo: false,
        undoReason: 'OSG lyrics editor v1: text',
        redoReason: null,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);
  await expect(service.getProjectHistoryStatus()).resolves.toEqual({
    stateVersion: 6,
    canUndo: true,
    canRedo: false,
    undoReason: 'OSG lyrics editor v1: text',
    redoReason: null,
  });

  let conflictLoadCount = 0;
  invokeCommand.mockImplementation(async (command) => {
    if (command === 'project_history_status') {
      return {
        stateVersion: 7,
        canUndo: true,
        canRedo: false,
        undoReason: 'OSG lyrics editor v1: external merge',
        redoReason: null,
      };
    }
    if (command === 'project_load') {
      conflictLoadCount += 1;
      return conflictLoadCount === 1
        ? snapshot(6, 'Loaded')
        : snapshot(7, 'External edit');
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  await expect(service.getProjectHistoryStatus()).rejects.toEqual(expect.objectContaining({
    name: 'ProjectConflictError',
    authoritativeSnapshot: snapshot(7, 'External edit'),
  }));
});

it('rejects inconsistent, unbounded, and control-bearing project history reasons', async () => {
  const invalidStatuses = [
    {
      stateVersion: 1,
      canUndo: false,
      canRedo: false,
      undoReason: 'edit',
      redoReason: null,
    },
    {
      stateVersion: 1,
      canUndo: true,
      canRedo: false,
      undoReason: 'x'.repeat(501),
      redoReason: null,
    },
    {
      stateVersion: 1,
      canUndo: true,
      canRedo: false,
      undoReason: 'edit\nforged',
      redoReason: null,
    },
  ];

  for (const invalid of invalidStatuses) {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'project_load') return snapshot(1);
      if (command === 'project_history_status') return invalid;
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    await service.activateProject(PROJECT_ID);
    await expect(service.getProjectHistoryStatus()).rejects.toMatchObject({
      code: 'invalidProjectHistoryStatus',
    });
  }
});

it('refreshes the active project when only the independent track status sees a newer revision', async () => {
  let loadCount = 0;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return snapshot(loadCount <= 2 ? 5 : 6);
    }
    if (command === 'project_track_history_status') {
      return trackStatus(6, 2, 'OSG lyrics editor v1: text');
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  await expect(service.getProjectTrackHistoryStatus(
    PROJECT_ID,
    TRACK_SELECTOR
  )).resolves.toEqual(trackStatus(6, 2, 'OSG lyrics editor v1: text'));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(6));
});

it('commits and navigates a track with its independent version and reason guards', async () => {
  const before = track('Before');
  const after = track('After');
  const committedSnapshot = { ...snapshot(8), tracks: [after] };
  const undoneSnapshot = { ...snapshot(9), tracks: [before] };
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(7);
    if (command === 'project_track_commit') {
      return {
        snapshot: committedSnapshot,
        status: trackStatus(8, 4, 'OSG lyrics editor v1: text'),
      };
    }
    if (command === 'project_track_undo') {
      return {
        snapshot: undoneSnapshot,
        status: trackStatus(9, 5, null, 'OSG lyrics editor v1: text'),
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  const committedTrack = await service.commitProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 3,
    beforeTrack: before,
    afterTrack: after,
    reason: 'OSG lyrics editor v1: text',
  });
  const undoneTrack = await service.undoProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 4,
    expectedReason: 'OSG lyrics editor v1: text',
  });
  expect(Object.isFrozen(committedTrack)).toBe(true);
  expect(Object.isFrozen(undoneTrack)).toBe(true);

  expect(invokeCommand).toHaveBeenCalledWith('project_track_commit', {
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 3,
    beforeTrack: before,
    afterTrack: after,
    reason: 'OSG lyrics editor v1: text',
  });
  expect(invokeCommand).toHaveBeenCalledWith('project_track_undo', {
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 4,
    expectedReason: 'OSG lyrics editor v1: text',
  });
  expect(service.getActiveProjectSnapshot()).toEqual(undoneSnapshot);
});

it('reloads authoritative state after a stale independent track writer', async () => {
  let loadCount = 0;
  const authoritative = { ...snapshot(11), tracks: [track('Authoritative')] };
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return loadCount <= 2 ? snapshot(10) : authoritative;
    }
    if (command === 'project_track_commit') {
      throw { code: 'staleProjectTrackHistory' };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  await expect(service.commitProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 1,
    beforeTrack: track('Before'),
    afterTrack: track('After'),
    reason: 'OSG lyrics editor v1: text',
  })).rejects.toMatchObject({
    name: 'ProjectConflictError',
    authoritativeSnapshot: authoritative,
  });
  expect(service.getActiveProjectSnapshot()).toEqual(authoritative);
});

it('bounds a native command that never replies so a later queued commit is not stalled behind it forever', async () => {
  vi.useFakeTimers();
  try {
    let trackCommitCalls = 0;
    const secondCommitted = { ...snapshot(8), tracks: [track('Second')] };
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'project_load') return snapshot(7);
      if (command === 'project_track_commit') {
        trackCommitCalls += 1;
        // The first call simulates a lost IPC round trip: the promise never settles, exactly
        // what a native reply that never arrives looks like from the WebView.
        if (trackCommitCalls === 1) return new Promise(() => undefined);
        return {
          snapshot: secondCommitted,
          status: trackStatus(8, 4, 'OSG lyrics editor v1: move range'),
        };
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
    // Queued behind the stuck commit, exactly like a multi-cue range move queued behind an
    // earlier drag's commit on the same project.
    const laterCommit = service.commitProjectTrack({
      id: PROJECT_ID,
      selector: TRACK_SELECTOR,
      expectedHistoryVersion: 4,
      beforeTrack: track('After'),
      afterTrack: track('Second'),
      reason: 'OSG lyrics editor v1: move range',
    });

    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);

    await expect(stuckCommit).rejects.toMatchObject({
      name: 'ProjectServiceError',
      code: 'projectCommandTimedOut',
      command: 'project_track_commit',
    });
    // The queue recovered: the later commit actually reached the native host and completed,
    // instead of waiting forever behind the first one.
    await expect(laterCommit).resolves.toMatchObject({ snapshot: secondCommitted });
    expect(trackCommitCalls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

it('rejects a diverged track status that advertises navigation', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(1);
    if (command === 'project_track_history_status') {
      return {
        ...trackStatus(1, 1, 'OSG lyrics editor v1: text'),
        diverged: true,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.loadProject(PROJECT_ID);
  await expect(service.getProjectTrackHistoryStatus(
    PROJECT_ID,
    TRACK_SELECTOR
  )).rejects.toMatchObject({ code: 'invalidProjectTrackHistoryStatus' });
});

it('supports guarded explicit activation and deactivation without stale clears', () => {
  const service = createProjectService({ invokeCommand: vi.fn() });
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  expect(service.activateProjectSnapshot(snapshotB(3))).toEqual(snapshotB(3));
  expect(service.deactivateProject({ expectedProjectId: PROJECT_ID })).toBe(false);
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(3));
  expect(service.deactivateProject({ expectedProjectId: PROJECT_B_ID })).toBe(true);
  expect(service.getActiveProjectSnapshot()).toBeNull();
  expect(service.deactivateProject()).toBe(true);

  expect(subscriber.mock.calls).toEqual([
    [snapshotB(3)],
    [null],
  ]);
});

it('lets the latest explicit activation win an older asynchronous activation load', async () => {
  const pendingLoad = deferred();
  const invokeCommand = vi.fn(() => pendingLoad.promise);
  const service = createProjectService({ invokeCommand });
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  const loadingA = service.activateProject(PROJECT_ID);
  await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
    'project_load',
    { id: PROJECT_ID }
  ));
  service.activateProjectSnapshot(snapshotB(2));
  pendingLoad.resolve(snapshot(7, 'Late A'));

  await expect(loadingA).resolves.toEqual(snapshot(7, 'Late A'));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(2));
  expect(subscriber.mock.calls).toEqual([[snapshotB(2)]]);
});

it('starts B activation while A is unresolved and publishes only the latest result', async () => {
  const pendingA = deferred();
  const pendingB = deferred();
  const invokeCommand = vi.fn((command, { id }) => {
    if (command !== 'project_load') throw new Error(`Unexpected command: ${command}`);
    if (id === PROJECT_ID) return pendingA.promise;
    if (id === PROJECT_B_ID) return pendingB.promise;
    throw new Error(`Unexpected project: ${id}`);
  });
  const service = createProjectService({ invokeCommand });
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  const loadingA = service.activateProject(PROJECT_ID);
  const loadingB = service.activateProject(PROJECT_B_ID);
  expect(invokeCommand.mock.calls).toEqual([
    ['project_load', { id: PROJECT_ID }],
    ['project_load', { id: PROJECT_B_ID }],
  ]);

  pendingB.resolve(snapshotB(4, 'Fast B'));
  await expect(loadingB).resolves.toEqual(snapshotB(4, 'Fast B'));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(4, 'Fast B'));
  pendingA.resolve(snapshot(6, 'Late A'));
  await expect(loadingA).resolves.toEqual(snapshot(6, 'Late A'));

  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(4, 'Fast B'));
  expect(subscriber.mock.calls).toEqual([[snapshotB(4, 'Fast B')]]);
});

it('guarded deactivation cancels only a matching pending activation', async () => {
  const unrelatedLoad = deferred();
  const unrelatedService = createProjectService({
    invokeCommand: vi.fn(() => unrelatedLoad.promise),
  });
  unrelatedService.activateProjectSnapshot(snapshotB(2));
  const unrelatedSubscriber = vi.fn();
  unrelatedService.subscribe(unrelatedSubscriber);
  const allowedA = unrelatedService.activateProject(PROJECT_ID);

  expect(unrelatedService.deactivateProject({ expectedProjectId: PROJECT_C_ID })).toBe(false);
  unrelatedLoad.resolve(snapshot(3, 'Allowed pending A'));
  await expect(allowedA).resolves.toEqual(snapshot(3, 'Allowed pending A'));
  expect(unrelatedService.getActiveProjectSnapshot()).toEqual(snapshot(3, 'Allowed pending A'));
  expect(unrelatedSubscriber).toHaveBeenCalledWith(snapshot(3, 'Allowed pending A'));

  const matchingLoad = deferred();
  const matchingService = createProjectService({
    invokeCommand: vi.fn(() => matchingLoad.promise),
  });
  matchingService.activateProjectSnapshot(snapshotB(5));
  const matchingSubscriber = vi.fn();
  matchingService.subscribe(matchingSubscriber);
  const cancelledA = matchingService.activateProject(PROJECT_ID);

  expect(matchingService.deactivateProject({ expectedProjectId: PROJECT_ID })).toBe(true);
  expect(matchingService.getActiveProjectSnapshot()).toEqual(snapshotB(5));
  matchingLoad.resolve(snapshot(6, 'Cancelled pending A'));
  await expect(cancelledA).resolves.toEqual(snapshot(6, 'Cancelled pending A'));
  expect(matchingService.getActiveProjectSnapshot()).toEqual(snapshotB(5));
  expect(matchingSubscriber).not.toHaveBeenCalled();
});

it('publishes re-entrant activation without recursion or stale delivery', () => {
  const service = createProjectService({ invokeCommand: vi.fn() });
  const sequence = [];
  const payloads = [];
  let depth = 0;
  let maximumDepth = 0;
  let unsubscribeSecond = () => {};
  const third = vi.fn((value) => {
    sequence.push(`third:${value.metadata.id}`);
    payloads.push(value);
  });
  service.subscribe((value) => {
    depth += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    sequence.push(`first:${value.metadata.id}`);
    payloads.push(value);
    if (value.metadata.id === PROJECT_ID) {
      unsubscribeSecond();
      service.subscribe(third);
      service.activateProjectSnapshot(snapshotB(7));
    }
    depth -= 1;
  });
  const second = vi.fn((value) => {
    sequence.push(`second:${value.metadata.id}`);
    payloads.push(value);
  });
  unsubscribeSecond = service.subscribe(second);

  const returnedA = service.activateProjectSnapshot(snapshot(3, 'Outer A'));

  expect(returnedA).toEqual(snapshot(3, 'Outer A'));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(7));
  expect(sequence).toEqual([
    `first:${PROJECT_ID}`,
    `first:${PROJECT_B_ID}`,
    `third:${PROJECT_B_ID}`,
  ]);
  expect(maximumDepth).toBe(1);
  expect(second).not.toHaveBeenCalled();
  expect(third).toHaveBeenCalledTimes(1);
  payloads.forEach((payload) => {
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.metadata)).toBe(true);
  });
});

it('settles a nested same-project mutation called after an await', async () => {
  const outerStarted = deferred();
  const releaseOuter = deferred();
  let storedSnapshot = snapshot();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') return storedSnapshot;
    if (command === 'project_commit') {
      if (args.snapshot.stateVersion !== storedSnapshot.stateVersion) {
        throw { code: 'staleProjectVersion' };
      }
      const stateVersion = storedSnapshot.stateVersion + 1;
      storedSnapshot = { ...args.snapshot, stateVersion };
      return { revisionId: REVISION_ONE, stateVersion };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot());

  const outer = service.mutateProject(PROJECT_ID, 'Outer async no-op', async (current) => {
    outerStarted.resolve();
    await releaseOuter.promise;
    await service.mutateProject(PROJECT_ID, 'Nested edit', (nested) => ({
      ...nested,
      metadata: { ...nested.metadata, name: 'Nested committed A' },
    }));
    return current;
  });
  await outerStarted.promise;
  releaseOuter.resolve();

  await expect(outer).resolves.toEqual(expect.objectContaining({
    committed: false,
    stateVersion: 1,
    snapshot: snapshot(1, 'Nested committed A'),
  }));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(1, 'Nested committed A'));
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'project_commit')).toHaveLength(1);
});

it('settles the exact post-await return of a nested mutation promise without deadlock', async () => {
  const releaseOuter = deferred();
  let storedSnapshot = snapshot();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') return storedSnapshot;
    if (command === 'project_commit') {
      storedSnapshot = { ...args.snapshot, stateVersion: 1 };
      return { revisionId: REVISION_ONE, stateVersion: 1 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  const outer = service.mutateProject(PROJECT_ID, 'Return nested result', async () => {
    await releaseOuter.promise;
    return service.mutateProject(PROJECT_ID, 'Nested result', (current) => ({
      ...current,
      metadata: { ...current.metadata, name: 'Nested durable result' },
    }));
  });
  releaseOuter.resolve();

  // A mutator must return a snapshot, not the nested commit wrapper, but this must reject rather
  // than self-wait forever after the nested operation durably settles.
  await expect(outer).rejects.toMatchObject({ code: 'invalidProjectSnapshot' });
  expect(storedSnapshot).toEqual(snapshot(1, 'Nested durable result'));
  await expect(service.readProject(PROJECT_ID)).resolves.toEqual(storedSnapshot);
});

it('settles a nested post-await failure and recovers the same-project queue', async () => {
  const outerStarted = deferred();
  const releaseOuter = deferred();
  let failHistory = true;
  let storedSnapshot = snapshot();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') return storedSnapshot;
    if (command === 'project_history_status') {
      if (failHistory) throw new Error('nested history failed');
      return {
        stateVersion: storedSnapshot.stateVersion,
        canUndo: false,
        canRedo: false,
        undoReason: null,
        redoReason: null,
      };
    }
    if (command === 'project_commit') {
      const stateVersion = storedSnapshot.stateVersion + 1;
      storedSnapshot = { ...args.snapshot, stateVersion };
      return { revisionId: REVISION_ONE, stateVersion };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });

  const outer = service.mutateProject(PROJECT_ID, 'Outer awaiting failure', async (current) => {
    outerStarted.resolve();
    await releaseOuter.promise;
    await service.getProjectHistoryStatus(PROJECT_ID);
    return current;
  });
  await outerStarted.promise;
  releaseOuter.resolve();
  await expect(outer).rejects.toThrow('nested history failed');

  failHistory = false;
  await expect(service.mutateProject(PROJECT_ID, 'Recovered edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Recovered after nested failure' },
  }))).resolves.toMatchObject({ stateVersion: 1 });
  await expect(service.getProjectHistoryStatus(PROJECT_ID)).resolves.toMatchObject({
    stateVersion: 1,
  });
});

it('gives an async mutator a CAS boundary while external synchronous work remains FIFO', async () => {
  const outerStarted = deferred();
  const releaseOuter = deferred();
  let storedSnapshot = snapshot();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') return storedSnapshot;
    if (command === 'project_commit') {
      if (args.snapshot.stateVersion !== storedSnapshot.stateVersion) {
        throw { code: 'staleProjectVersion' };
      }
      const stateVersion = storedSnapshot.stateVersion + 1;
      storedSnapshot = { ...args.snapshot, stateVersion };
      return {
        revisionId: stateVersion === 1 ? REVISION_ONE : REVISION_TWO,
        stateVersion,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });

  const outer = service.mutateProject(PROJECT_ID, 'Yielding outer edit', async (current) => {
    outerStarted.resolve();
    await releaseOuter.promise;
    return { ...current, metadata: { ...current.metadata, name: 'Late outer edit' } };
  });
  await outerStarted.promise;
  const externalOne = service.mutateProject(PROJECT_ID, 'External synchronous edit one', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'External one' },
  }));
  const externalTwo = service.mutateProject(PROJECT_ID, 'External synchronous edit two', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'External two' },
  }));

  await expect(externalOne).resolves.toMatchObject({ stateVersion: 1 });
  await expect(externalTwo).resolves.toMatchObject({ stateVersion: 2 });
  releaseOuter.resolve();
  await expect(outer).rejects.toMatchObject({
    name: 'ProjectConflictError',
    authoritativeSnapshot: snapshot(2, 'External two'),
  });
  expect(storedSnapshot).toEqual(snapshot(2, 'External two'));
});

it('keeps newer queue tails through failure cleanup and ABA-style re-enqueueing', async () => {
  const firstCommit = deferred();
  const secondCommit = deferred();
  let loadCount = 0;
  let commitCount = 0;
  let storedSnapshot = snapshot();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') {
      loadCount += 1;
      return storedSnapshot;
    }
    if (command === 'project_commit') {
      commitCount += 1;
      if (commitCount === 1) return firstCommit.promise;
      if (commitCount === 2) {
        const result = await secondCommit.promise;
        storedSnapshot = { ...args.snapshot, stateVersion: result.stateVersion };
        return result;
      }
      storedSnapshot = { ...args.snapshot, stateVersion: 2 };
      return { revisionId: REVISION_THREE, stateVersion: 2 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  const first = service.mutateProject(PROJECT_ID, 'First fails', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'First' },
  }));
  const second = service.mutateProject(PROJECT_ID, 'Second waits', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Second' },
  }));
  await vi.waitFor(() => expect(commitCount).toBe(1));
  expect(loadCount).toBe(1);
  firstCommit.reject(new Error('first failed'));
  await expect(first).rejects.toThrow('first failed');
  await vi.waitFor(() => expect(commitCount).toBe(2));
  expect(loadCount).toBe(2);

  const third = service.mutateProject(PROJECT_ID, 'Third stays behind second', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Third' },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(loadCount).toBe(2);
  secondCommit.resolve({ revisionId: REVISION_TWO, stateVersion: 1 });
  await expect(second).resolves.toMatchObject({ stateVersion: 1 });
  await expect(third).resolves.toMatchObject({ stateVersion: 2 });
  expect(storedSnapshot).toEqual(snapshot(2, 'Third'));
});

it('does not publish a queued A mutation after B becomes active', async () => {
  const pendingCommit = deferred();
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot();
    if (command === 'project_commit') return pendingCommit.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot());
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  const mutation = service.mutateProject(PROJECT_ID, 'Background A edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Committed A' },
  }));
  await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
    'project_commit',
    expect.anything()
  ));
  service.activateProjectSnapshot(snapshotB(5));
  pendingCommit.resolve({ revisionId: REVISION_ONE, stateVersion: 1 });

  await expect(mutation).resolves.toMatchObject({
    stateVersion: 1,
    snapshot: snapshot(1, 'Committed A'),
  });
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(5));
  expect(subscriber.mock.calls).toEqual([[snapshotB(5)]]);
});

it('never restores a captured A snapshot when its queued commit fails after B activates', async () => {
  const pendingCommit = deferred();
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(4, 'A before error');
    if (command === 'project_commit') return pendingCommit.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot(4, 'A before error'));
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  const mutation = service.mutateProject(PROJECT_ID, 'Failing A edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Uncommitted A' },
  }));
  await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
    'project_commit',
    expect.anything()
  ));
  service.activateProjectSnapshot(snapshotB(8));
  pendingCommit.reject(new Error('disk full'));

  await expect(mutation).rejects.toThrow('disk full');
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(8));
  expect(subscriber.mock.calls).toEqual([[snapshotB(8)]]);
});

it('keeps B active when A disappears across reads, activation, mutation, and history', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return null;
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshotB(4));
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  await expect(service.readProject(PROJECT_ID)).resolves.toBeNull();
  await expect(service.activateProject(PROJECT_ID)).resolves.toBeNull();
  await expect(service.mutateProject(
    PROJECT_ID,
    'Missing A edit',
    (current) => current
  )).rejects.toMatchObject({ code: 'projectNotFound' });
  await expect(service.getProjectHistoryStatus(PROJECT_ID)).rejects.toMatchObject({
    code: 'projectNotFound',
  });

  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(4));
  expect(subscriber).not.toHaveBeenCalled();
});

it('rejects a valid snapshot whose ID differs on every public project-load path', async () => {
  const operations = [
    ['read', (service) => service.readProject(PROJECT_ID)],
    ['compatibility load', (service) => service.loadProject(PROJECT_ID)],
    ['reload', (service) => service.reloadProject(PROJECT_ID)],
    ['activation', (service) => service.activateProject(PROJECT_ID)],
    ['history', (service) => service.getProjectHistoryStatus(PROJECT_ID)],
    ['track history', (service) => service.getProjectTrackHistoryStatus(
      PROJECT_ID,
      TRACK_SELECTOR
    )],
  ];

  for (const [label, operation] of operations) {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'project_load') return snapshotB(2, `Wrong B for ${label}`);
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    service.activateProjectSnapshot(snapshot(1, 'Existing A'));
    const subscriber = vi.fn();
    service.subscribe(subscriber);

    await expect(operation(service)).rejects.toMatchObject({
      code: 'invalidProjectLoad',
      projectId: PROJECT_ID,
      returnedProjectId: PROJECT_B_ID,
    });
    expect(service.getActiveProjectSnapshot()).toEqual(snapshot(1, 'Existing A'));
    expect(subscriber, label).not.toHaveBeenCalled();
  }
});

it('wraps a wrong-ID authoritative conflict reload without publishing it', async () => {
  let loadCount = 0;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return loadCount === 1 ? snapshot() : snapshotB(8, 'Wrong authoritative B');
    }
    if (command === 'project_commit') throw { code: 'staleProjectVersion' };
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot());
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  await expect(service.mutateProject(PROJECT_ID, 'Conflicting edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Local A' },
  }))).rejects.toMatchObject({
    code: 'projectReloadFailed',
    projectId: PROJECT_ID,
    reloadError: expect.objectContaining({
      code: 'invalidProjectLoad',
      returnedProjectId: PROJECT_B_ID,
    }),
  });
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot());
  expect(subscriber).not.toHaveBeenCalled();
});

it('keeps background A project history and track navigation detached from active B', async () => {
  const undoneTrackSnapshot = { ...snapshot(2, 'Track A'), tracks: [track('Before')] };
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot();
    if (command === 'project_history_status') {
      return {
        stateVersion: 0,
        canUndo: false,
        canRedo: false,
        undoReason: null,
        redoReason: null,
      };
    }
    if (command === 'project_undo') return snapshot(1, 'Undone A');
    if (command === 'project_track_undo') {
      return {
        snapshot: undoneTrackSnapshot,
        status: trackStatus(2, 4, null, 'OSG lyrics editor v1: text'),
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshotB(9));
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  await expect(service.getProjectHistoryStatus(PROJECT_ID)).resolves.toMatchObject({
    stateVersion: 0,
  });
  await expect(service.undoProject(PROJECT_ID)).resolves.toEqual(snapshot(1, 'Undone A'));
  await expect(service.undoProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 3,
    expectedReason: 'OSG lyrics editor v1: text',
  })).resolves.toEqual({
    snapshot: undoneTrackSnapshot,
    status: trackStatus(2, 4, null, 'OSG lyrics editor v1: text'),
  });

  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(9));
  expect(subscriber).not.toHaveBeenCalled();
});

it('refreshes active A from authoritative no-op, status, and null-navigation loads', async () => {
  const refreshedSnapshots = [
    snapshot(2, 'No-op authoritative A'),
    snapshot(3, 'History authoritative A'),
    snapshot(4, 'Null project navigation A'),
    snapshot(5, 'Track status authoritative A'),
    snapshot(6, 'Null track navigation A'),
  ];
  const loadResponses = [refreshedSnapshots[0], ...refreshedSnapshots];
  let loadIndex = 0;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      const result = loadResponses[loadIndex];
      loadIndex += 1;
      return result;
    }
    if (command === 'project_history_status') {
      return {
        stateVersion: 3,
        canUndo: false,
        canRedo: false,
        undoReason: null,
        redoReason: null,
      };
    }
    if (command === 'project_undo' || command === 'project_track_undo') return null;
    if (command === 'project_track_history_status') return trackStatus(5, 2);
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot(1, 'Initially active A'));
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  await expect(service.mutateProject(
    PROJECT_ID,
    'Authoritative no-op',
    (current) => current
  )).resolves.toMatchObject({ committed: false, stateVersion: 2 });
  await expect(service.getProjectHistoryStatus(PROJECT_ID)).resolves.toMatchObject({
    stateVersion: 3,
  });
  await expect(service.undoProject(PROJECT_ID)).resolves.toBeNull();
  await expect(service.getProjectTrackHistoryStatus(
    PROJECT_ID,
    TRACK_SELECTOR
  )).resolves.toEqual(trackStatus(5, 2));
  await expect(service.undoProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 2,
    expectedReason: 'OSG lyrics editor v1: text',
  })).resolves.toBeNull();

  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(6, 'Null track navigation A'));
  expect(subscriber.mock.calls).toEqual(refreshedSnapshots.map((value) => [value]));
});

it('does not refresh a delayed no-op A after B wins', async () => {
  const releaseMutator = deferred();
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(4, 'Authoritative A');
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot(1, 'Active A'));
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  const mutation = service.mutateProject(PROJECT_ID, 'Delayed no-op A', async (current) => {
    await releaseMutator.promise;
    return current;
  });
  await vi.waitFor(() => expect(invokeCommand).toHaveBeenCalledWith(
    'project_load',
    { id: PROJECT_ID }
  ));
  service.activateProjectSnapshot(snapshotB(10));
  releaseMutator.resolve();

  await expect(mutation).resolves.toMatchObject({ committed: false, stateVersion: 4 });
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(10));
  expect(subscriber.mock.calls).toEqual([[snapshotB(10)]]);
});

it('does not let delayed commit or no-op results regress a newer explicit A activation', async () => {
  const pendingCommit = deferred();
  const commitInvoke = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(2, 'Loaded A v2');
    if (command === 'project_commit') return pendingCommit.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const commitService = createProjectService({ invokeCommand: commitInvoke });
  commitService.activateProjectSnapshot(snapshot(1, 'Old active A'));
  const commitSubscriber = vi.fn();
  commitService.subscribe(commitSubscriber);
  const committing = commitService.mutateProject(PROJECT_ID, 'Delayed commit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Committed host A v3' },
  }));
  await vi.waitFor(() => expect(commitInvoke).toHaveBeenCalledWith(
    'project_commit',
    expect.anything()
  ));
  const newerCommitActivation = snapshot(10, 'Explicit A v10');
  commitService.activateProjectSnapshot(newerCommitActivation);
  pendingCommit.resolve({ revisionId: REVISION_ONE, stateVersion: 3 });
  await expect(committing).resolves.toMatchObject({ stateVersion: 3 });
  expect(commitService.getActiveProjectSnapshot()).toEqual(newerCommitActivation);
  expect(commitSubscriber.mock.calls).toEqual([[newerCommitActivation]]);

  const releaseNoOp = deferred();
  const noOpService = createProjectService({
    invokeCommand: vi.fn(async (command) => {
      if (command === 'project_load') return snapshot(4, 'Loaded A v4');
      throw new Error(`Unexpected command: ${command}`);
    }),
  });
  noOpService.activateProjectSnapshot(snapshot(3, 'Old active A'));
  const noOpSubscriber = vi.fn();
  noOpService.subscribe(noOpSubscriber);
  const noOp = noOpService.mutateProject(PROJECT_ID, 'Delayed no-op', async (current) => {
    await releaseNoOp.promise;
    return current;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newerNoOpActivation = snapshot(20, 'Explicit A v20');
  noOpService.activateProjectSnapshot(newerNoOpActivation);
  releaseNoOp.resolve();
  await expect(noOp).resolves.toMatchObject({ committed: false, stateVersion: 4 });
  expect(noOpService.getActiveProjectSnapshot()).toEqual(newerNoOpActivation);
  expect(noOpSubscriber.mock.calls).toEqual([[newerNoOpActivation]]);
});

it('does not let delayed status or null navigation regress a newer A activation', async () => {
  const pendingStatus = deferred();
  const statusInvoke = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(2, 'Status load A v2');
    if (command === 'project_history_status') return pendingStatus.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const statusService = createProjectService({ invokeCommand: statusInvoke });
  statusService.activateProjectSnapshot(snapshot(1, 'Old active A'));
  const statusSubscriber = vi.fn();
  statusService.subscribe(statusSubscriber);
  const status = statusService.getProjectHistoryStatus(PROJECT_ID);
  await vi.waitFor(() => expect(statusInvoke).toHaveBeenCalledWith(
    'project_history_status',
    { id: PROJECT_ID }
  ));
  const newerStatusActivation = snapshot(10, 'Explicit status A v10');
  statusService.activateProjectSnapshot(newerStatusActivation);
  pendingStatus.resolve({
    stateVersion: 2,
    canUndo: false,
    canRedo: false,
    undoReason: null,
    redoReason: null,
  });
  await expect(status).resolves.toMatchObject({ stateVersion: 2 });
  expect(statusService.getActiveProjectSnapshot()).toEqual(newerStatusActivation);
  expect(statusSubscriber.mock.calls).toEqual([[newerStatusActivation]]);

  const pendingNavigation = deferred();
  const navigationInvoke = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(3, 'Navigation load A v3');
    if (command === 'project_undo') return pendingNavigation.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const navigationService = createProjectService({ invokeCommand: navigationInvoke });
  navigationService.activateProjectSnapshot(snapshot(1, 'Old active A'));
  const navigationSubscriber = vi.fn();
  navigationService.subscribe(navigationSubscriber);
  const navigation = navigationService.undoProject(PROJECT_ID);
  await vi.waitFor(() => expect(navigationInvoke).toHaveBeenCalledWith(
    'project_undo',
    { id: PROJECT_ID, expectedVersion: 3 }
  ));
  const newerNavigationActivation = snapshot(20, 'Explicit navigation A v20');
  navigationService.activateProjectSnapshot(newerNavigationActivation);
  pendingNavigation.resolve(null);
  await expect(navigation).resolves.toBeNull();
  expect(navigationService.getActiveProjectSnapshot()).toEqual(newerNavigationActivation);
  expect(navigationSubscriber.mock.calls).toEqual([[newerNavigationActivation]]);
});

it('does not let delayed project conflict reload or track mutation regress newer A', async () => {
  const pendingReload = deferred();
  let conflictLoadCount = 0;
  const conflictInvoke = vi.fn(async (command) => {
    if (command === 'project_load') {
      conflictLoadCount += 1;
      return conflictLoadCount === 1 ? snapshot(2, 'Conflict load A') : pendingReload.promise;
    }
    if (command === 'project_commit') throw { code: 'staleProjectVersion' };
    throw new Error(`Unexpected command: ${command}`);
  });
  const conflictService = createProjectService({ invokeCommand: conflictInvoke });
  conflictService.activateProjectSnapshot(snapshot(1, 'Old active A'));
  const conflictSubscriber = vi.fn();
  conflictService.subscribe(conflictSubscriber);
  const conflict = conflictService.mutateProject(PROJECT_ID, 'Delayed conflict', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Local conflict A' },
  }));
  await vi.waitFor(() => expect(conflictLoadCount).toBe(2));
  const newerConflictActivation = snapshot(30, 'Explicit conflict A v30');
  conflictService.activateProjectSnapshot(newerConflictActivation);
  pendingReload.resolve(snapshot(5, 'Host authoritative A v5'));
  await expect(conflict).rejects.toMatchObject({
    name: 'ProjectConflictError',
    authoritativeSnapshot: snapshot(5, 'Host authoritative A v5'),
  });
  expect(conflictService.getActiveProjectSnapshot()).toEqual(newerConflictActivation);
  expect(conflictSubscriber.mock.calls).toEqual([[newerConflictActivation]]);

  const pendingTrack = deferred();
  const after = track('Track host result');
  const trackInvoke = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(2, 'Track load A');
    if (command === 'project_track_commit') return pendingTrack.promise;
    throw new Error(`Unexpected command: ${command}`);
  });
  const trackService = createProjectService({ invokeCommand: trackInvoke });
  trackService.activateProjectSnapshot(snapshot(1, 'Old active A'));
  const trackSubscriber = vi.fn();
  trackService.subscribe(trackSubscriber);
  const trackCommit = trackService.commitProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 1,
    beforeTrack: track('Before'),
    afterTrack: after,
    reason: 'OSG lyrics editor v1: text',
  });
  await vi.waitFor(() => expect(trackInvoke).toHaveBeenCalledWith(
    'project_track_commit',
    expect.anything()
  ));
  const newerTrackActivation = snapshot(40, 'Explicit track A v40');
  trackService.activateProjectSnapshot(newerTrackActivation);
  pendingTrack.resolve({
    snapshot: { ...snapshot(3, 'Track host A v3'), tracks: [after] },
    status: trackStatus(3, 2, 'OSG lyrics editor v1: text'),
  });
  await expect(trackCommit).resolves.toMatchObject({
    snapshot: { stateVersion: 3 },
  });
  expect(trackService.getActiveProjectSnapshot()).toEqual(newerTrackActivation);
  expect(trackSubscriber.mock.calls).toEqual([[newerTrackActivation]]);
});

it('does not let a delayed authoritative A conflict reload overwrite active B', async () => {
  const pendingReload = deferred();
  let loadCount = 0;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return loadCount === 1 ? snapshot() : pendingReload.promise;
    }
    if (command === 'project_commit') {
      throw { code: 'staleProjectVersion', message: 'stale' };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot());
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  const mutation = service.mutateProject(PROJECT_ID, 'Conflicting A edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Local A' },
  }));
  await vi.waitFor(() => expect(loadCount).toBe(2));
  service.activateProjectSnapshot(snapshotB(6));
  pendingReload.resolve(snapshot(11, 'Authoritative A'));

  await expect(mutation).rejects.toMatchObject({
    name: 'ProjectConflictError',
    authoritativeSnapshot: snapshot(11, 'Authoritative A'),
  });
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB(6));
  expect(subscriber.mock.calls).toEqual([[snapshotB(6)]]);
});

it('isolates subscriber failures while publishing a completed active-project mutation', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(2, 'Active A');
    if (command === 'project_commit') {
      return { revisionId: REVISION_ONE, stateVersion: 3 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshot(2, 'Active A'));
  const error = new Error('subscriber failed');
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  service.subscribe(() => { throw error; });
  const healthySubscriber = vi.fn();
  service.subscribe(healthySubscriber);

  await expect(service.mutateProject(PROJECT_ID, 'Active A edit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Updated A' },
  }))).resolves.toMatchObject({ stateVersion: 3 });

  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(3, 'Updated A'));
  expect(healthySubscriber).toHaveBeenCalledWith(snapshot(3, 'Updated A'));
  expect(consoleError).toHaveBeenCalledWith(
    '[projectService] Active-project subscriber failed:',
    error
  );
  consoleError.mockRestore();
});

it('returns and publishes independent deeply immutable snapshot copies', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(5, 'Read A');
    if (command === 'project_commit') {
      return { revisionId: REVISION_ONE, stateVersion: 6 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  const payloads = [];
  service.subscribe((value) => {
    payloads.push(value);
    expect(Reflect.set(value.metadata, 'name', 'Poisoned by first subscriber')).toBe(false);
    expect(Reflect.set(value.media, '0', { id: 'poison' })).toBe(false);
  });
  service.subscribe((value) => payloads.push(value));

  const activated = service.activateProjectSnapshot(snapshot(4, 'Immutable A'));
  const activeCopy = service.getActiveProjectSnapshot();
  expect(Reflect.set(activated.metadata, 'name', 'Poisoned caller result')).toBe(false);
  expect(Reflect.set(activeCopy.metadata, 'name', 'Poisoned active copy')).toBe(false);
  expect(activated).not.toBe(activeCopy);
  expect(payloads[0]).not.toBe(payloads[1]);
  expect(payloads[0]).not.toBe(activated);
  expect(payloads[1]).toEqual(snapshot(4, 'Immutable A'));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(4, 'Immutable A'));
  [activated, activeCopy, ...payloads].forEach((value) => {
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.metadata)).toBe(true);
    expect(Object.isFrozen(value.media)).toBe(true);
    expect(Object.isFrozen(value.tracks)).toBe(true);
  });

  const readResult = await service.readProject(PROJECT_ID);
  expect(Object.isFrozen(readResult)).toBe(true);
  expect(Object.isFrozen(readResult.metadata)).toBe(true);
  expect(Reflect.set(readResult.metadata, 'name', 'Poisoned read')).toBe(false);

  const directCommit = await service.commitProject({
    ...readResult,
    metadata: { ...readResult.metadata, name: 'Direct immutable commit' },
  }, 'Direct immutable commit');
  expect(Object.isFrozen(directCommit)).toBe(true);
  expect(Object.isFrozen(directCommit.snapshot)).toBe(true);

  const mutation = await service.mutateProject(PROJECT_ID, 'Immutable commit', (current) => ({
    ...current,
    metadata: { ...current.metadata, name: 'Committed immutable A' },
  }));
  expect(Object.isFrozen(mutation)).toBe(true);
  expect(Object.isFrozen(mutation.snapshot)).toBe(true);
  expect(Object.isFrozen(mutation.snapshot.metadata)).toBe(true);
  expect(Reflect.set(mutation.snapshot.metadata, 'name', 'Poisoned commit')).toBe(false);
});

it('exposes a dedicated typed conflict error', () => {
  const error = new ProjectConflictError(PROJECT_ID, snapshot(3), new Error('cause'));
  expect(error).toMatchObject({
    name: 'ProjectConflictError',
    code: 'staleProjectVersion',
    projectId: PROJECT_ID,
  });
});
