// durableLyricsHistory: browser fail-closed, restart restore, commit ordering and cache binding.

import { createDurableLyricsHistory, LYRICS_EDITOR_ACTIONS } from './durableLyricsHistory';
import { deferred, rows, editorStatus } from './durableLyricsHistoryTestFixtures';

vi.mock('./desktopRuntime', () => ({
  isDesktopRuntime: vi.fn(() => false),
  invokeDesktop: vi.fn(),
}));

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
