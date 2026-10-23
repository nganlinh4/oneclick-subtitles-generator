// projectService: create, detached mutation, conflict reload, navigation and published-copy semantics.

import { createProjectService, PROJECT_COMMAND_TIMEOUT_MS, ProjectConflictError } from './projectService';
import {
  PROJECT_ID,
  PROJECT_B_ID,
  REVISION_ONE,
  REVISION_TWO,
  snapshot,
  snapshotB,
  deferred,
} from './projectServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

it('bridges detached create and read using the exact Tauri argument contract', async () => {
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot(2));
  const service = createProjectService({ invokeCommand });
  service.activateProjectSnapshot(snapshotB());
  const subscriber = vi.fn();
  service.subscribe(subscriber);

  await expect(service.createDetachedProject('Example', 'cache:example')).resolves.toEqual(snapshot());
  await expect(service.readProject(PROJECT_ID)).resolves.toEqual(snapshot(2));
  expect(invokeCommand.mock.calls).toEqual([
    ['project_create', { name: 'Example', idempotencyKey: 'cache:example' }],
    ['project_load', { id: PROJECT_ID }],
  ]);
  expect(service.createProject).toBe(service.createDetachedProject);
  expect(service.loadProject).toBe(service.readProject);
  expect(service.mutateProject).toBe(service.mutateDetachedProject);
  expect(service.getActiveProjectSnapshot()).toEqual(snapshotB());
  expect(subscriber).not.toHaveBeenCalled();
});

it('requires callers to own a stable create identity before native work starts', () => {
  const invokeCommand = vi.fn();
  const service = createProjectService({ invokeCommand });

  expect(() => service.createProject('Example')).toThrow(expect.objectContaining({
    code: 'invalidProjectCreateKey',
  }));
  expect(() => service.createProject('Example', 'hostile\u0085key')).toThrow(expect.objectContaining({
    code: 'invalidProjectCreateKey',
  }));
  expect(invokeCommand).not.toHaveBeenCalled();
});

it('retries the same durable create identity after timeout and converges on a late success', async () => {
  vi.useFakeTimers();
  try {
    const firstNative = deferred();
    let durable = null;
    const invokeCommand = vi.fn((command, args) => {
      if (command !== 'project_create') throw new Error(`Unexpected command: ${command}`);
      if (invokeCommand.mock.calls.length === 1) return firstNative.promise;
      expect(args.idempotencyKey).toBe('cache:late-success');
      return Promise.resolve(durable);
    });
    const service = createProjectService({ invokeCommand });
    const first = service.createProject('Example', 'cache:late-success');
    const timeoutAssertion = expect(first).rejects.toMatchObject({
      code: 'projectCommandTimedOut',
      command: 'project_create',
      idempotencyKey: 'cache:late-success',
      retrySafe: true,
    });

    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);
    await timeoutAssertion;

    durable = snapshot();
    firstNative.resolve(durable);
    await expect(service.createProject('Example', 'cache:late-success')).resolves.toEqual(durable);
    expect(invokeCommand).toHaveBeenCalledTimes(2);
    expect(invokeCommand.mock.calls[0][1]).toEqual(invokeCommand.mock.calls[1][1]);
  } finally {
    vi.useRealTimers();
  }
});

it('permits an exact create retry when the timed-out native attempt later fails', async () => {
  vi.useFakeTimers();
  try {
    const firstNative = deferred();
    const invokeCommand = vi.fn((command) => {
      if (command !== 'project_create') throw new Error(`Unexpected command: ${command}`);
      return invokeCommand.mock.calls.length === 1
        ? firstNative.promise
        : Promise.resolve(snapshot());
    });
    const service = createProjectService({ invokeCommand });
    const first = service.createProject('Example', 'cache:late-failure');
    const timeoutAssertion = expect(first).rejects.toMatchObject({
      code: 'projectCommandTimedOut', retrySafe: true,
    });

    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);
    await timeoutAssertion;
    firstNative.reject(new Error('native transaction failed after timeout'));
    await expect(service.createProject('Example', 'cache:late-failure')).resolves.toEqual(snapshot());
    expect(invokeCommand.mock.calls.map(([, args]) => args.idempotencyKey)).toEqual([
      'cache:late-failure',
      'cache:late-failure',
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it('does not let a never-settling create block its idempotent retry or unrelated projects', async () => {
  vi.useFakeTimers();
  try {
    const invokeCommand = vi.fn((command, args) => {
      if (command === 'project_load') return Promise.resolve(snapshotB());
      if (command === 'project_create' && invokeCommand.mock.calls.filter(
        ([candidate]) => candidate === 'project_create'
      ).length === 1) return new Promise(() => undefined);
      if (command === 'project_create') {
        expect(args.idempotencyKey).toBe('cache:never-settles');
        return Promise.resolve(snapshot());
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    const first = service.createProject('Example', 'cache:never-settles');
    const timeoutAssertion = expect(first).rejects.toMatchObject({
      code: 'projectCommandTimedOut', retrySafe: true,
    });

    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);
    await timeoutAssertion;
    await expect(service.readProject(PROJECT_B_ID)).resolves.toEqual(snapshotB());
    await expect(service.createProject('Example', 'cache:never-settles')).resolves.toEqual(snapshot());
  } finally {
    vi.useRealTimers();
  }
});

it('recovers a lost create reply after desktop restart by replaying the stable identity', async () => {
  vi.useFakeTimers();
  try {
    const durableReceipts = new Map();
    const oldHost = vi.fn((command, args) => {
      if (command !== 'project_create') throw new Error(`Unexpected command: ${command}`);
      durableReceipts.set(args.idempotencyKey, snapshot());
      return new Promise(() => undefined);
    });
    const oldService = createProjectService({ invokeCommand: oldHost });
    const first = oldService.createProject('Example', 'cache:restart');
    const timeoutAssertion = expect(first).rejects.toMatchObject({
      code: 'projectCommandTimedOut', retrySafe: true,
    });
    await vi.advanceTimersByTimeAsync(PROJECT_COMMAND_TIMEOUT_MS);
    await timeoutAssertion;

    const restartedHost = vi.fn((command, args) => {
      if (command !== 'project_create') throw new Error(`Unexpected command: ${command}`);
      return Promise.resolve(durableReceipts.get(args.idempotencyKey));
    });
    const restartedService = createProjectService({ invokeCommand: restartedHost });
    await expect(restartedService.createProject('Example', 'cache:restart')).resolves.toEqual(
      snapshot()
    );
    expect(durableReceipts.size).toBe(1);
  } finally {
    vi.useRealTimers();
  }
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
