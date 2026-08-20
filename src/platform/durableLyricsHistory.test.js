import {
  createDurableLyricsHistory,
  LYRICS_EDITOR_ACTIONS,
} from './durableLyricsHistory';

vi.mock('./desktopRuntime', () => ({
  isDesktopRuntime: vi.fn(() => false),
  invokeDesktop: vi.fn(),
}));

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const rows = (text) => [{ id: 1, start: 0, end: 1, text }];
const editorStatus = (
  undoReason = null,
  redoReason = null,
  stateVersion = 1,
  historyVersion = stateVersion
) => ({
  stateVersion,
  historyVersion,
  diverged: false,
  canUndo: undoReason !== null,
  canRedo: redoReason !== null,
  undoReason,
  redoReason,
});

it('fails closed in browser preview without touching the native revision store', async () => {
  const revisions = {
    commit: vi.fn(),
    status: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => false,
    currentCacheId: () => 'cache-id',
    revisions,
  });

  await history.refresh();
  await history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  const circularRows = [];
  circularRows.push(circularRows);
  await expect(history.record(
    circularRows,
    circularRows,
    LYRICS_EDITOR_ACTIONS.TEXT
  )).resolves.toMatchObject({ native: false });
  await history.undo();
  expect(revisions.commit).not.toHaveBeenCalled();
  expect(revisions.status).not.toHaveBeenCalled();
  expect(revisions.undo).not.toHaveBeenCalled();
});

it('restores only exact namespaced editor navigation after restart', async () => {
  const onStatus = vi.fn();
  const revisions = {
    commit: vi.fn(),
    status: vi.fn()
      .mockResolvedValueOnce(editorStatus('OSG lyrics editor v1: text'))
      .mockResolvedValueOnce(editorStatus('Save cached subtitles')),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    onStatus,
  });

  await expect(history.refresh()).resolves.toMatchObject({ canUndo: true, canRedo: false });
  await expect(history.undo()).resolves.toMatchObject({ navigated: false });
  expect(revisions.undo).not.toHaveBeenCalled();
  expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ canUndo: false }));
});

it('serializes rapid edits and undo behind their durable commits', async () => {
  const first = deferred();
  const calls = [];
  let commitCount = 0;
  const revisions = {
    commit: vi.fn(async (_cacheId, before, after, reason) => {
      commitCount += 1;
      calls.push(`commit:${before[0].text}->${after[0].text}:${reason}`);
      if (commitCount === 1) await first.promise;
      return { status: editorStatus(reason, null, commitCount) };
    }),
    status: vi.fn(async () => {
      calls.push('status');
      return editorStatus('OSG lyrics editor v1: text', null, 2);
    }),
    undo: vi.fn(async (_cacheId, historyVersion, reason) => {
      expect(historyVersion).toBe(2);
      calls.push(`undo:${reason}`);
      return {
        rows: rows('B'),
        status: editorStatus('OSG lyrics editor v1: text', reason, 3),
      };
    }),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
  });

  const editOne = history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  const editTwo = history.record(rows('B'), rows('C'), LYRICS_EDITOR_ACTIONS.TEXT);
  const undo = history.undo();
  await Promise.resolve();
  expect(calls).toEqual([
    'commit:A->B:OSG lyrics editor v1: text',
  ]);

  first.resolve();
  await Promise.all([editOne, editTwo, undo]);
  expect(calls).toEqual([
    'commit:A->B:OSG lyrics editor v1: text',
    'commit:B->C:OSG lyrics editor v1: text',
    'status',
    'undo:OSG lyrics editor v1: text',
  ]);
});

it('reconciles only the newest failed optimistic operation', async () => {
  const reconciled = [];
  let attempt = 0;
  const revisions = {
    commit: vi.fn(async () => {
      attempt += 1;
      const error = new Error('stale');
      error.authoritativeRows = rows(`Server ${attempt}`);
      throw error;
    }),
    status: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    onReconcile: (value) => reconciled.push(value),
    onError: () => undefined,
  });

  await Promise.all([
    history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT),
    history.record(rows('B'), rows('C'), LYRICS_EDITOR_ACTIONS.TEXT),
  ]);
  expect(reconciled).toEqual([rows('Server 2')]);
});

it('reconciles a track changed outside the editor while disabling its stale cursor', async () => {
  const onReconcile = vi.fn();
  const revisions = {
    commit: vi.fn(),
    status: vi.fn(async () => ({
      ...editorStatus(null, null, 5, 2),
      diverged: true,
      authoritativeRows: rows('Authoritative'),
    })),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    onReconcile,
  });

  await expect(history.refresh()).resolves.toMatchObject({
    diverged: true,
    canUndo: false,
    canRedo: false,
  });
  expect(onReconcile).toHaveBeenCalledWith(rows('Authoritative'));
});

it('binds callbacks to one cache while allowing the previous project write to finish', async () => {
  let cacheId = 'first';
  const first = deferred();
  const statuses = [];
  const revisions = {
    commit: vi.fn(async (id) => {
      if (id === 'first') await first.promise;
      return { status: editorStatus('OSG lyrics editor v1: text') };
    }),
    status: vi.fn(async () => editorStatus(null, null, 0)),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => cacheId,
    revisions,
    onStatus: (value) => statuses.push({ cacheId, ...value }),
  });

  const oldWrite = history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  cacheId = 'second';
  const refresh = history.refresh();
  first.resolve();
  await Promise.all([oldWrite, refresh]);

  expect(revisions.commit).toHaveBeenCalledWith(
    'first',
    rows('A'),
    rows('B'),
    'OSG lyrics editor v1: text'
  );
  expect(revisions.status).toHaveBeenCalledWith('second');
  expect(statuses.at(-1)).toMatchObject({ cacheId: 'second', canUndo: false });
});

it('does not poison the current project with a stale project write failure', async () => {
  let cacheId = 'first';
  const first = deferred();
  const oldError = new Error('old project failed');
  const revisions = {
    commit: vi.fn(async () => {
      await first.promise;
      throw oldError;
    }),
    status: vi.fn(async () => editorStatus(null, null, 0)),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => cacheId,
    revisions,
    onError: () => undefined,
  });

  const oldWrite = history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  cacheId = 'second';
  const refresh = history.refresh();
  first.resolve();

  await expect(oldWrite).resolves.toMatchObject({ ok: false, error: oldError });
  await refresh;
  await expect(history.flush()).resolves.toBeUndefined();
});

it('clears durable redo when a rapid post-undo edit creates a new branch', async () => {
  const editReason = 'OSG lyrics editor v1: text';
  const revisionsList = [
    { rows: rows('A'), reason: 'Save cached subtitles' },
    { rows: rows('B'), reason: editReason },
    { rows: rows('C'), reason: editReason },
  ];
  let cursor = 2;
  let redoIndexes = [];
  const currentStatus = () => editorStatus(
    cursor > 0 ? revisionsList[cursor].reason : null,
    redoIndexes.length > 0 ? revisionsList[redoIndexes.at(-1)].reason : null,
    cursor + redoIndexes.length
  );
  const revisions = {
    status: vi.fn(async () => currentStatus()),
    undo: vi.fn(async (_cacheId, _historyVersion, expectedReason) => {
      expect(expectedReason).toBe(revisionsList[cursor].reason);
      redoIndexes.push(cursor);
      cursor -= 1;
      return { rows: revisionsList[cursor].rows, status: currentStatus() };
    }),
    redo: vi.fn(async () => {
      cursor = redoIndexes.pop();
      return { rows: revisionsList[cursor].rows, status: currentStatus() };
    }),
    commit: vi.fn(async (_cacheId, _before, after, reason) => {
      revisionsList.splice(cursor + 1, revisionsList.length, { rows: after, reason });
      cursor += 1;
      redoIndexes = [];
      return { status: currentStatus() };
    }),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
  });

  await expect(history.undo()).resolves.toMatchObject({ navigated: true, rows: rows('B') });
  await history.record(rows('B'), rows('D'), LYRICS_EDITOR_ACTIONS.TEXT);
  await expect(history.redo()).resolves.toMatchObject({ navigated: false });

  expect(revisionsList.map((revision) => revision.rows[0].text)).toEqual(['A', 'B', 'D']);
  expect(revisions.redo).not.toHaveBeenCalled();
});

it('bounds a slow native writer queue and reconciles after backpressure', async () => {
  const first = deferred();
  const reconciled = [];
  const errors = [];
  let commitCount = 0;
  const revisions = {
    commit: vi.fn(async (_cacheId, _before, _after, reason) => {
      commitCount += 1;
      if (commitCount === 1) await first.promise;
      return { status: editorStatus(reason, null, commitCount) };
    }),
    load: vi.fn(async () => rows('Native C')),
    status: vi.fn(async () => editorStatus('OSG lyrics editor v1: text', null, 2)),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    maxPendingOperations: 2,
    onReconcile: (value) => reconciled.push(value),
    onError: (error) => errors.push(error),
  });

  const firstWrite = history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  const secondWrite = history.record(rows('B'), rows('C'), LYRICS_EDITOR_ACTIONS.TEXT);
  const circularRows = [];
  circularRows.push(circularRows);
  const rejected = await history.record(
    circularRows,
    circularRows,
    LYRICS_EDITOR_ACTIONS.TEXT
  );
  const rejectedNavigation = await history.undo();
  await Promise.resolve();
  expect(rejected).toMatchObject({ ok: false, backpressure: true });
  expect(rejected.error).toMatchObject({ code: 'historyQueueSaturated', limit: 2 });
  expect(rejectedNavigation).toMatchObject({ ok: false, backpressure: true });
  expect(revisions.commit).toHaveBeenCalledTimes(1);
  expect(revisions.undo).not.toHaveBeenCalled();

  first.resolve();
  await Promise.all([firstWrite, secondWrite]);
  await expect(history.flush()).rejects.toMatchObject({ code: 'historyQueueSaturated' });
  expect(revisions.commit).toHaveBeenCalledTimes(2);
  expect(revisions.load).toHaveBeenCalledWith('cache-id');
  expect(revisions.load).toHaveBeenCalledTimes(1);
  expect(reconciled).toEqual([rows('Native C')]);
  expect(errors).toHaveLength(2);

  await history.record(rows('Native C'), rows('E'), LYRICS_EDITOR_ACTIONS.TEXT);
  expect(revisions.commit).toHaveBeenCalledTimes(3);
});

it('reserves aggregate queue bytes and releases them after recovery', async () => {
  const first = deferred();
  const reconciled = [];
  const pairBytes = JSON.stringify(rows('A')).length + JSON.stringify(rows('B')).length;
  const revisions = {
    commit: vi.fn(async (_cacheId, _before, _after, reason) => {
      if (revisions.commit.mock.calls.length === 1) await first.promise;
      return { status: editorStatus(reason, null, revisions.commit.mock.calls.length) };
    }),
    load: vi.fn(async () => rows('B')),
    status: vi.fn(async () => editorStatus('OSG lyrics editor v1: text', null, 1)),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    maxPendingOperations: 4,
    maxPendingBytes: pairBytes,
    maxStateBytes: pairBytes,
    onReconcile: (value) => reconciled.push(value),
    onError: () => undefined,
  });

  const accepted = history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  const rejected = await history.record(rows('B'), rows('C'), LYRICS_EDITOR_ACTIONS.TEXT);
  expect(rejected).toMatchObject({ backpressure: true });
  expect(revisions.commit).toHaveBeenCalledTimes(1);

  first.resolve();
  await accepted;
  await expect(history.flush()).rejects.toMatchObject({ code: 'historyQueueSaturated' });
  expect(reconciled).toEqual([rows('B')]);

  await history.record(rows('B'), rows('D'), LYRICS_EDITOR_ACTIONS.TEXT);
  expect(revisions.commit).toHaveBeenCalledTimes(2);
});

it('rejects a single oversized history state without calling the native writer', async () => {
  const reconciled = [];
  const revisions = {
    commit: vi.fn(),
    load: vi.fn(async () => rows('A')),
    status: vi.fn(async () => editorStatus(null, null, 0)),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    maxStateBytes: JSON.stringify(rows('A')).length,
    maxPendingBytes: 1_024,
    onReconcile: (value) => reconciled.push(value),
    onError: () => undefined,
  });

  const result = await history.record(
    rows('A'),
    rows('text that exceeds the injected state limit'),
    LYRICS_EDITOR_ACTIONS.TEXT
  );
  expect(result).toMatchObject({
    ok: false,
    backpressure: true,
    error: { code: 'historySnapshotTooLarge' },
  });
  await expect(history.flush()).rejects.toMatchObject({ code: 'historySnapshotTooLarge' });
  expect(revisions.commit).not.toHaveBeenCalled();
  expect(reconciled).toEqual([rows('A')]);
});

it('uses the newer status rows when recovery observes a concurrent divergence', async () => {
  const reconciled = [];
  const transportError = new Error('transport failed');
  const revisions = {
    commit: vi.fn(async () => { throw transportError; }),
    load: vi.fn(async () => rows('Loaded A')),
    status: vi.fn(async () => ({
      ...editorStatus(null, null, 2),
      diverged: true,
      authoritativeRows: rows('Status B'),
    })),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    onReconcile: (value) => reconciled.push(value),
    onError: () => undefined,
  });

  await expect(history.record(
    rows('A'),
    rows('Optimistic'),
    LYRICS_EDITOR_ACTIONS.TEXT
  )).resolves.toMatchObject({ ok: false });
  await expect(history.flush()).rejects.toBe(transportError);
  expect(reconciled).toEqual([rows('Status B')]);
});

it('rejects every concurrent flush in the failure cohort, then permits a later flush', async () => {
  const writeError = new Error('write failed');
  const revisions = {
    commit: vi.fn(async () => { throw writeError; }),
    load: vi.fn(async () => rows('Authoritative')),
    status: vi.fn(async () => editorStatus(null, null, 1)),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    onError: () => undefined,
  });
  await history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);

  const results = await Promise.allSettled([history.flush(), history.flush()]);
  expect(results).toEqual([
    { status: 'rejected', reason: writeError },
    { status: 'rejected', reason: writeError },
  ]);
  await expect(history.flush()).resolves.toBeUndefined();
});

it('still reconciles when an injected error callback throws', async () => {
  const writeError = new Error('write failed');
  const reconciled = [];
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const revisions = {
    commit: vi.fn(async () => { throw writeError; }),
    load: vi.fn(async () => rows('Authoritative')),
    status: vi.fn(async () => editorStatus(null, null, 1)),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    onError: () => { throw new Error('host callback failed'); },
    onReconcile: (value) => reconciled.push(value),
  });

  await history.record(rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  await expect(history.flush()).rejects.toBe(writeError);
  expect(reconciled).toEqual([rows('Authoritative')]);
  consoleError.mockRestore();
});

it('reconciles a generic failed undo and keeps flush blocked while recovery fails', async () => {
  const reconciled = [];
  const undoError = new Error('undo transport failed');
  const recoveryError = new Error('recovery failed');
  let recoveryCanSucceed = false;
  const revisions = {
    commit: vi.fn(),
    load: vi.fn(async () => {
      if (!recoveryCanSucceed) throw recoveryError;
      return rows('Authoritative');
    }),
    status: vi.fn()
      .mockResolvedValueOnce(editorStatus('OSG lyrics editor v1: text', null, 1))
      .mockResolvedValue(editorStatus(null, null, 1)),
    undo: vi.fn(async () => { throw undoError; }),
    redo: vi.fn(),
  };
  const history = createDurableLyricsHistory({
    runtimeAvailable: () => true,
    currentCacheId: () => 'cache-id',
    revisions,
    onReconcile: (value) => reconciled.push(value),
    onError: () => undefined,
  });

  await expect(history.undo()).resolves.toMatchObject({ ok: false });
  await expect(history.flush()).rejects.toBe(recoveryError);
  await expect(history.flush()).rejects.toBe(recoveryError);
  expect(reconciled).toEqual([]);

  recoveryCanSucceed = true;
  await expect(history.flush()).rejects.toBe(recoveryError);
  expect(reconciled).toEqual([rows('Authoritative')]);
  await expect(history.flush()).resolves.toBeUndefined();
});
