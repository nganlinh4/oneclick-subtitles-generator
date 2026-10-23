// projectService: explicit activation, re-entrant publication and the per-project mutation queue.

import { createProjectService } from './projectService';
import {
  PROJECT_ID,
  PROJECT_B_ID,
  PROJECT_C_ID,
  REVISION_ONE,
  REVISION_TWO,
  REVISION_THREE,
  snapshot,
  snapshotB,
  deferred,
} from './projectServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

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
