// subtitleProjectStore: captured segment revisions commit only their own range.

import { SUBTITLE_CACHE_TRACK_LABEL } from './subtitleProjectStore';
import { readLegacySubtitleTrack } from './projectSnapshotAdapter';
import {
  PROJECT_ID,
  existingIndex,
  snapshotWithRows,
  createTestStore,
} from './subtitleProjectStoreTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

it('atomically replaces only the captured segment while preserving a racing outside edit', async () => {
  let current = snapshotWithRows(4, [
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 6, text: 'old target' },
    { start: 9, end: 10, text: 'after' },
  ]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 7,
      undoReason: null,
      redoReason: null,
      diverged: current.stateVersion > 4,
    })),
    commitProjectTrack: vi.fn(async (request) => {
      expect(request).toMatchObject({
        id: PROJECT_ID,
        expectedHistoryVersion: 7,
        reason: 'Replace regenerated subtitle segment',
      });
      expect(request.beforeTrack.cues[0].text).toBe('concurrent manual edit');
      current = {
        ...current,
        stateVersion: current.stateVersion + 1,
        tracks: request.afterTrack === null ? [] : [request.afterTrack],
      };
      return {
        snapshot: current,
        status: {
          stateVersion: current.stateVersion,
          historyVersion: 8,
          diverged: false,
          canUndo: true,
          canRedo: false,
          undoReason: request.reason,
          redoReason: null,
        },
      };
    }),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });
  const revision = await store.captureSegmentRevision(
    'cache-id',
    { start: 5, end: 8 },
    { expectedProjectId: PROJECT_ID }
  );

  current = snapshotWithRows(5, [
    { start: 0, end: 2, text: 'concurrent manual edit' },
    { start: 5, end: 6, text: 'old target' },
    { start: 9, end: 10, text: 'after' },
  ]);
  const result = await store.commitSegmentRevision(revision, [
    { start: 5, end: 7, text: 'replacement' },
  ], { expectedProjectId: PROJECT_ID });

  expect(Object.isFrozen(revision)).toBe(true);
  expect(result.rows).toEqual([
    { id: 1, start: 0, end: 2, text: 'concurrent manual edit' },
    { id: 2, start: 5, end: 7, text: 'replacement' },
    { id: 3, start: 9, end: 10, text: 'after' },
  ]);
  expect(projects.commitProjectTrack).toHaveBeenCalledTimes(1);
});

it('rejects an overlapping manual edit instead of overwriting the newer segment', async () => {
  let current = snapshotWithRows(4, [
    { start: 5, end: 6, text: 'old target' },
  ]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 2,
      undoReason: null,
      redoReason: null,
      diverged: false,
    })),
    commitProjectTrack: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });
  const revision = await store.captureSegmentRevision('cache-id', { start: 5, end: 8 });
  current = snapshotWithRows(5, [
    { start: 5, end: 6, text: 'newer manual target edit' },
  ]);

  await expect(store.commitSegmentRevision(revision, [
    { start: 5, end: 7, text: 'stale replacement' },
  ])).rejects.toMatchObject({ code: 'subtitleSegmentConflict' });
  expect(projects.commitProjectTrack).not.toHaveBeenCalled();
  expect(readLegacySubtitleTrack(current, { label: SUBTITLE_CACHE_TRACK_LABEL }))
    .toEqual([{ id: 1, start: 5, end: 6, text: 'newer manual target edit' }]);
});

it('commits a captured empty replacement as an intentional range deletion', async () => {
  let current = snapshotWithRows(4, [
    { start: 0, end: 2, text: 'before' },
    { start: 5, end: 6, text: 'old target' },
    { start: 9, end: 10, text: 'after' },
  ]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 2,
      undoReason: null,
      redoReason: null,
      diverged: false,
    })),
    commitProjectTrack: vi.fn(async (request) => {
      current = {
        ...current,
        stateVersion: current.stateVersion + 1,
        tracks: request.afterTrack === null ? [] : [request.afterTrack],
      };
      return {
        snapshot: current,
        status: {
          stateVersion: current.stateVersion,
          historyVersion: 3,
          diverged: false,
          canUndo: true,
          canRedo: false,
          undoReason: request.reason,
          redoReason: null,
        },
      };
    }),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });
  const revision = await store.captureSegmentRevision('cache-id', { start: 5, end: 8 });

  const result = await store.commitSegmentRevision(revision, []);

  expect(result.rows).toEqual([
    { id: 1, start: 0, end: 2, text: 'before' },
    { id: 2, start: 9, end: 10, text: 'after' },
  ]);
  expect(projects.commitProjectTrack).toHaveBeenCalledTimes(1);
});
