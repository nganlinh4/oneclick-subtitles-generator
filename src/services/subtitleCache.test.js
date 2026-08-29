import {
  captureProjectSubtitleSegmentRevision,
  clearProjectSubtitles,
  commitProjectSubtitleSegmentRevision,
  loadExactProjectSubtitles,
  loadProjectSubtitles,
  resolveProjectForCache,
  saveProjectSubtitles,
} from '../platform/subtitleProjectStore';
import {
  captureDurableSubtitleSegmentRevision,
  commitDurableSubtitleCheckpoint,
  commitDurableSubtitleSegmentCheckpoint,
  getCachedSubtitles,
  isDurableSubtitleCheckpointReceipt,
  requireSuccessfulSubtitleCacheSave,
  saveSubtitlesToCache,
} from './subtitleCache';

vi.mock('../platform/subtitleProjectStore', () => ({
  captureProjectSubtitleSegmentRevision: vi.fn(),
  clearProjectSubtitles: vi.fn(),
  commitProjectSubtitleSegmentRevision: vi.fn(),
  loadExactProjectSubtitles: vi.fn(),
  loadProjectSubtitles: vi.fn(),
  resolveProjectForCache: vi.fn(),
  saveProjectSubtitles: vi.fn(),
}));

beforeEach(() => {
  captureProjectSubtitleSegmentRevision.mockReset();
  loadProjectSubtitles.mockReset();
  loadExactProjectSubtitles.mockReset();
  clearProjectSubtitles.mockReset();
  commitProjectSubtitleSegmentRevision.mockReset();
  resolveProjectForCache.mockReset();
  saveProjectSubtitles.mockReset();
  resolveProjectForCache.mockResolvedValue({ projectId: 'project-id' });
  localStorage.clear();
});

it('brands a segment receipt only after an exact captured revision commits', async () => {
  const context = Object.freeze({
    runId: 'segment-run',
    cacheId: 'cache-id',
    projectId: 'project-id',
    segment: Object.freeze({ start: 5, end: 8 }),
    signal: new AbortController().signal,
  });
  const revision = Object.freeze({
    kind: 'subtitle-segment-revision',
    cacheId: 'cache-id',
    projectId: 'project-id',
  });
  const replacement = [{ start: 5, end: 7, text: 'Replacement' }];
  const authoritativeRows = [
    { start: 0, end: 2, text: 'Manual edit' },
    ...replacement,
  ];
  const validateOwnership = vi.fn(async (value) => value);
  captureProjectSubtitleSegmentRevision.mockResolvedValue(revision);
  commitProjectSubtitleSegmentRevision.mockResolvedValue({
    cacheId: 'cache-id',
    projectId: 'project-id',
    stateVersion: 9,
    rows: authoritativeRows,
  });

  await expect(captureDurableSubtitleSegmentRevision({
    context,
    validateOwnership,
  })).resolves.toBe(revision);
  const receipt = await commitDurableSubtitleSegmentCheckpoint({
    context,
    revision,
    replacement,
    validateOwnership,
  });

  expect(commitProjectSubtitleSegmentRevision).toHaveBeenCalledWith(revision, replacement, {
    expectedProjectId: 'project-id',
  });
  expect(receipt).toMatchObject({
    kind: 'durable-subtitle-segment-checkpoint',
    runId: 'segment-run',
    cacheId: 'cache-id',
    projectId: 'project-id',
    subtitleCount: 2,
    subtitles: authoritativeRows,
    stateVersion: 9,
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(isDurableSubtitleCheckpointReceipt(receipt, context)).toBe(true);
  expect(isDurableSubtitleCheckpointReceipt({ ...receipt }, context)).toBe(false);
  expect(validateOwnership).toHaveBeenCalledTimes(4);
});

it('brands an empty segment replacement so proven silence can durably clear stale cues', async () => {
  const context = Object.freeze({
    runId: 'silent-run',
    cacheId: 'cache-id',
    projectId: 'project-id',
    segment: Object.freeze({ start: 5, end: 8 }),
  });
  const revision = Object.freeze({ kind: 'subtitle-segment-revision' });
  const validateOwnership = vi.fn(async (value) => value);
  commitProjectSubtitleSegmentRevision.mockResolvedValue({
    cacheId: 'cache-id',
    projectId: 'project-id',
    stateVersion: 10,
    rows: [{ start: 0, end: 2, text: 'outside' }],
  });

  const receipt = await commitDurableSubtitleSegmentCheckpoint({
    context,
    revision,
    replacement: [],
    validateOwnership,
  });

  expect(commitProjectSubtitleSegmentRevision).toHaveBeenCalledWith(revision, [], {
    expectedProjectId: 'project-id',
  });
  expect(receipt.subtitles).toEqual([{ start: 0, end: 2, text: 'outside' }]);
  expect(isDurableSubtitleCheckpointReceipt(receipt, context)).toBe(true);
});

it('distinguishes a cache miss from a redacted native read failure', async () => {
  loadProjectSubtitles.mockResolvedValueOnce(null);
  await expect(getCachedSubtitles('missing')).resolves.toBeNull();

  loadProjectSubtitles.mockRejectedValueOnce(new Error('C:\\Users\\person\\osg.sqlite3'));
  const error = await getCachedSubtitles('broken').catch((failure) => failure);
  expect(error).toMatchObject({
    code: 'subtitleCacheReadFailed',
    message: 'Saved subtitles could not be loaded.',
  });
  expect(JSON.stringify(error)).not.toContain('person');
});

it('loads an exact captured project instead of following a remapped cache alias', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Project A' }];
  loadExactProjectSubtitles.mockResolvedValueOnce(rows);

  await expect(getCachedSubtitles('cache-id', null, {
    expectedProjectId: 'project-a',
  })).resolves.toBe(rows);

  expect(loadExactProjectSubtitles).toHaveBeenCalledExactlyOnceWith(
    'cache-id',
    'project-a',
  );
  expect(loadProjectSubtitles).not.toHaveBeenCalled();
});

it('returns a fixed failed save and lets durable callers fail closed', async () => {
  saveProjectSubtitles.mockRejectedValueOnce(new Error('C:\\private\\osg.sqlite3'));
  const result = await saveSubtitlesToCache('cache-id', [{ start: 0, end: 1, text: 'Keep' }]);

  expect(result).toMatchObject({
    success: false,
    error: {
      code: 'subtitleCacheSaveFailed',
      message: 'Subtitles could not be saved.',
    },
  });
  expect(JSON.stringify(result)).not.toContain('private');
  expect(() => requireSuccessfulSubtitleCacheSave(result)).toThrowError(expect.objectContaining({
    code: 'subtitleCacheSaveFailed',
  }));
  expect(() => requireSuccessfulSubtitleCacheSave({ success: false, error: new Error('private') }))
    .toThrowError(expect.objectContaining({ code: 'subtitleCacheSaveFailed' }));
});

it('persists an intentionally empty editor state by clearing the native track', async () => {
  clearProjectSubtitles.mockResolvedValueOnce(true);

  await expect(saveSubtitlesToCache('cache-id', [])).resolves.toEqual({
    success: true,
    cacheId: 'cache-id',
    projectId: 'project-id',
    subtitleCount: 0,
  });

  expect(clearProjectSubtitles).toHaveBeenCalledWith('cache-id', {
    expectedProjectId: 'project-id',
  });
  expect(saveProjectSubtitles).not.toHaveBeenCalled();
});

it('uses project commands in Tauri without probing localhost or WebView storage', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Native' }];
  loadProjectSubtitles.mockResolvedValue(rows);
  saveProjectSubtitles.mockResolvedValue({ stateVersion: 1 });
  const storageSpy = vi.spyOn(Storage.prototype, 'getItem');

  await expect(getCachedSubtitles('cache-id', 'https://example.test/video')).resolves.toEqual(rows);
  await expect(saveSubtitlesToCache('cache-id', rows)).resolves.toEqual({
    success: true,
    cacheId: 'cache-id',
    projectId: 'project-id',
    subtitleCount: 1,
  });

  expect(loadProjectSubtitles).toHaveBeenCalledWith('cache-id');
  expect(saveProjectSubtitles).toHaveBeenCalledWith('cache-id', rows, {
    expectedProjectId: 'project-id',
  });
  expect(storageSpy).not.toHaveBeenCalled();
  storageSpy.mockRestore();
});

it('returns a frozen captured-run receipt only after validating both sides of the write', async () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Owned' }];
  saveProjectSubtitles.mockResolvedValue({ metadata: { id: 'project-id' } });
  const validateOwnership = vi.fn(async (context) => context);
  const context = Object.freeze({
    runId: 'run-1',
    cacheId: 'cache-id',
    projectId: 'project-id',
    signal: new AbortController().signal,
  });

  const receipt = await commitDurableSubtitleCheckpoint({
    context,
    subtitles: rows,
    validateOwnership,
  });

  expect(receipt).toEqual({
    kind: 'durable-subtitle-checkpoint',
    runId: 'run-1',
    cacheId: 'cache-id',
    projectId: 'project-id',
    subtitleCount: 1,
  });
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(isDurableSubtitleCheckpointReceipt(receipt, context)).toBe(true);
  expect(isDurableSubtitleCheckpointReceipt({ ...receipt }, context)).toBe(false);
  expect(validateOwnership).toHaveBeenCalledTimes(2);
  expect(validateOwnership.mock.invocationCallOrder[0])
    .toBeLessThan(saveProjectSubtitles.mock.invocationCallOrder[0]);
  expect(validateOwnership.mock.invocationCallOrder[1])
    .toBeGreaterThan(saveProjectSubtitles.mock.invocationCallOrder[0]);
});
