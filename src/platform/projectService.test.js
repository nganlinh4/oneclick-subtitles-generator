import { createProjectService, ProjectConflictError } from './projectService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const REVISION_ONE = '01890f39-7b62-7c4e-8c9a-000000000102';
const REVISION_TWO = '01890f39-7b62-7c4e-8c9a-000000000103';
const TRACK_ID = '01890f39-7b62-7c4e-8c9a-000000000104';
const CUE_ID = '01890f39-7b62-7c4e-8c9a-000000000105';
const TRACK_SELECTOR = Object.freeze({ label: 'Cached subtitles', origin: 'legacyJson' });

const snapshot = (stateVersion = 0, name = 'Example') => ({
  metadata: { id: PROJECT_ID, name },
  stateVersion,
  media: [],
  tracks: [],
});
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

it('bridges create and load using the exact Tauri argument contract', async () => {
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot(2));
  const service = createProjectService({ invokeCommand });

  await expect(service.createProject('Example')).resolves.toEqual(snapshot());
  await expect(service.loadProject(PROJECT_ID)).resolves.toEqual(snapshot(2));
  expect(invokeCommand.mock.calls).toEqual([
    ['project_create', { name: 'Example' }],
    ['project_load', { id: PROJECT_ID }],
  ]);
});

it('serializes optimistic mutations and builds each queued snapshot from the last commit', async () => {
  const firstCommit = deferred();
  const committedSnapshots = [];
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') return snapshot();
    if (command === 'project_commit') {
      committedSnapshots.push(args.snapshot);
      if (committedSnapshots.length === 1) return firstCommit.promise;
      return { revisionId: REVISION_TWO, stateVersion: 2 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.loadProject(PROJECT_ID);

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
  expect(service.getActiveProjectSnapshot().metadata.name).toBe('First');

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
  await service.loadProject(PROJECT_ID);

  await expect(service.mutateProject(
    PROJECT_ID,
    'No-op save',
    (current) => current,
  )).resolves.toEqual({
    revisionId: null,
    stateVersion: 3,
    snapshot: snapshot(3, 'Same'),
    committed: false,
  });
  expect(invokeCommand).not.toHaveBeenCalledWith('project_commit', expect.anything());
});

it('reloads authoritative state on conflict and recovers the queue for later work', async () => {
  let loadCount = 0;
  let commitCount = 0;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return loadCount === 1 ? snapshot() : snapshot(4, 'External edit');
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
  await service.loadProject(PROJECT_ID);

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
  await service.loadProject(PROJECT_ID);

  await expect(service.mutateProject(
    PROJECT_ID,
    'Retry edit',
    (current) => ({ ...current, metadata: { ...current.metadata, name: 'Local wins this field' } }),
    { retryOnConflict: true }
  )).resolves.toMatchObject({ stateVersion: 3 });
  expect(committedSnapshots[1]).toEqual(snapshot(2, 'Local wins this field'));
});

it('sends optimistic versions for undo and redo and accepts empty navigation results', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(6);
    if (command === 'project_undo') return snapshot(7, 'Undone');
    if (command === 'project_redo') return null;
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.loadProject(PROJECT_ID);

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
  await service.loadProject(PROJECT_ID);

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
  await service.loadProject(PROJECT_ID);
  await expect(service.getProjectHistoryStatus()).resolves.toEqual({
    stateVersion: 6,
    canUndo: true,
    canRedo: false,
    undoReason: 'OSG lyrics editor v1: text',
    redoReason: null,
  });

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
    if (command === 'project_load') return snapshot(7, 'External edit');
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
    await service.loadProject(PROJECT_ID);
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
      return snapshot(loadCount === 1 ? 5 : 6);
    }
    if (command === 'project_track_history_status') {
      return trackStatus(6, 2, 'OSG lyrics editor v1: text');
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.loadProject(PROJECT_ID);

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
  await service.loadProject(PROJECT_ID);

  await service.commitProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 3,
    beforeTrack: before,
    afterTrack: after,
    reason: 'OSG lyrics editor v1: text',
  });
  await service.undoProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 4,
    expectedReason: 'OSG lyrics editor v1: text',
  });

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
      return loadCount === 1 ? snapshot(10) : authoritative;
    }
    if (command === 'project_track_commit') {
      throw { code: 'staleProjectTrackHistory' };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.loadProject(PROJECT_ID);

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

it('exposes a dedicated typed conflict error', () => {
  const error = new ProjectConflictError(PROJECT_ID, snapshot(3), new Error('cause'));
  expect(error).toMatchObject({
    name: 'ProjectConflictError',
    code: 'staleProjectVersion',
    projectId: PROJECT_ID,
  });
});
