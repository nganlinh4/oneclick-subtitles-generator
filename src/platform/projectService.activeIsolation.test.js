// projectService: wrong-ID loads and delayed results never regress or overwrite the active project.

import { createProjectService } from './projectService';
import {
  PROJECT_ID,
  PROJECT_B_ID,
  REVISION_ONE,
  TRACK_SELECTOR,
  snapshot,
  snapshotB,
  track,
  trackStatus,
  deferred,
} from './projectServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

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
