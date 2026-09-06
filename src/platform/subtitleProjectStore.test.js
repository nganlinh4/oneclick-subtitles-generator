import {
  createSubtitleProjectStore,
  MAX_SUBTITLE_PROJECT_ALIASES,
  SUBTITLE_CACHE_TRACK_LABEL,
} from './subtitleProjectStore';
import {
  readLegacySubtitleTrack,
  replaceLegacySubtitleTrack,
} from './projectSnapshotAdapter';
import { getActiveTranscript, setActiveTranscript } from './transcriptStore';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000201';
const TRACK_ID = '01890f39-7b62-7c4e-8c9a-000000000202';
const CUE_ID = '01890f39-7b62-7c4e-8c9a-000000000203';

const snapshot = (stateVersion = 0, tracks = []) => ({
  metadata: { id: PROJECT_ID, name: 'cache-id' },
  stateVersion,
  media: [],
  tracks,
});

const track = () => ({
  id: TRACK_ID,
  label: SUBTITLE_CACHE_TRACK_LABEL,
  origin: 'legacyJson',
  cues: [{
    id: CUE_ID,
    ordinal: 1,
    startMs: 1_250,
    endMs: 2_500,
    text: 'Stored',
    sourceId: null,
  }],
});

const existingIndex = () => ({
  schemaVersion: 1,
  activeCacheId: 'cache-id',
  entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 100 }],
});

const snapshotWithRows = (stateVersion, rows) => replaceLegacySubtitleTrack(
  snapshot(stateVersion),
  rows,
  { label: SUBTITLE_CACHE_TRACK_LABEL }
);

it('creates a project alias once and commits cache rows through the project mutation queue', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'subtitle_project_index_get') return null;
    if (command === 'subtitle_project_index_set') return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
  const projects = {
    loadProject: vi.fn(),
    createProject: vi.fn().mockResolvedValue(snapshot()),
    mutateProject: vi.fn(async (id, reason, mutator, options) => {
      expect(id).toBe(PROJECT_ID);
      expect(reason).toBe('Save cached subtitles');
      expect(options).toEqual({ retryOnConflict: true });
      const candidate = mutator(snapshot());
      return { snapshot: { ...candidate, stateVersion: 1 } };
    }),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 123 });

  const saved = await store.saveSubtitles('cache-id', [
    { id: 1, start: 1.25, end: 2.5, text: 'Stored' },
  ]);

  expect(saved).toMatchObject({ stateVersion: 1 });
  expect(saved.tracks[0]).toMatchObject({
    label: SUBTITLE_CACHE_TRACK_LABEL,
    origin: 'legacyJson',
  });
  expect(saved.tracks[0].cues[0]).toMatchObject({
    startMs: 1_250,
    endMs: 2_500,
    text: 'Stored',
  });
  expect(projects.createProject).toHaveBeenCalledWith('cache-id', 'cache-id');
  expect(invokeCommand).toHaveBeenCalledWith('subtitle_project_index_set', {
    index: {
      schemaVersion: 1,
      activeCacheId: 'cache-id',
      entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 123 }],
    },
  });
});

it('refuses to mutate an alias that no longer resolves to the captured project', async () => {
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValue(snapshot()),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 123 });

  await expect(store.saveSubtitles(
    'cache-id',
    [{ id: 1, start: 1.25, end: 2.5, text: 'Stale' }],
    { expectedProjectId: '01890f39-7b62-7c4e-8c9a-000000000999' }
  )).rejects.toMatchObject({ code: 'projectScopeMismatch' });

  expect(projects.mutateProject).not.toHaveBeenCalled();
});

it('loads seconds-based rows from an existing canonical cache project', async () => {
  const persistedIndex = {
    schemaVersion: 1,
    activeCacheId: 'cache-id',
    entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 100 }],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? persistedIndex : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValue(snapshot(3, [track()])),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });

  await expect(store.loadSubtitles('cache-id')).resolves.toEqual([
    { id: 1, start: 1.25, end: 2.5, text: 'Stored' },
  ]);
  expect(projects.createProject).not.toHaveBeenCalled();
  expect(projects.loadProject).toHaveBeenCalledWith(PROJECT_ID);
});

it('rejects an exact-project cache read when its project was deleted before alias repair', async () => {
  const replacementId = '01890f39-7b62-7c4e-8c9a-000000000204';
  const replacement = {
    metadata: { id: replacementId, name: 'cache-id' },
    stateVersion: 0,
    media: [],
    tracks: [],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
    createProject: vi.fn().mockResolvedValue(replacement),
    mutateProject: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 300 });

  await expect(store.loadExactProjectSubtitles('cache-id', PROJECT_ID))
    .rejects.toMatchObject({ code: 'projectScopeMismatch' });
  await expect(store.resolveProjectForCache('cache-id', { create: true }))
    .resolves.toMatchObject({ projectId: replacementId });

  expect(projects.createProject).toHaveBeenCalledTimes(1);
  expect(projects.loadProject).not.toHaveBeenCalledWith(replacementId);
});

it('recovers a legacy-sync serialized project index without replacing its project', async () => {
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? JSON.stringify(existingIndex()) : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValue(snapshot(3, [track()])),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });

  await expect(store.loadSubtitles('cache-id')).resolves.toEqual([
    { id: 1, start: 1.25, end: 2.5, text: 'Stored' },
  ]);
  expect(projects.loadProject).toHaveBeenCalledWith(PROJECT_ID);
  expect(projects.createProject).not.toHaveBeenCalled();
  expect(invokeCommand).toHaveBeenCalledWith('subtitle_project_index_set', {
    index: expect.objectContaining({ activeCacheId: 'cache-id' }),
  });
});

it('clears only the cached subtitle track through an optimistic project revision', async () => {
  const persistedIndex = {
    schemaVersion: 1,
    activeCacheId: 'cache-id',
    entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 100 }],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? persistedIndex : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValue(snapshot(3, [track()])),
    createProject: vi.fn(),
    mutateProject: vi.fn(async (id, reason, mutator, options) => {
      expect(id).toBe(PROJECT_ID);
      expect(reason).toBe('Clear cached subtitles for retry');
      expect(options).toEqual({ retryOnConflict: true });
      const candidate = mutator(snapshot(3, [track()]));
      expect(candidate.tracks).toEqual([]);
      return { snapshot: { ...candidate, stateVersion: 4 } };
    }),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });

  setActiveTranscript({ projectId: PROJECT_ID, revisionId: 'rev-1', words: [{ text: 'hi' }], turns: [] });
  await expect(store.clearSubtitles('cache-id')).resolves.toBe(true);
  expect(getActiveTranscript()).toBeNull();
  expect(projects.mutateProject).toHaveBeenCalledTimes(1);
  expect(projects.createProject).not.toHaveBeenCalled();
});

it('does not create or commit a project when clearing a cache miss', async () => {
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? null : undefined
  ));
  const projects = {
    loadProject: vi.fn(),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects });

  await expect(store.clearSubtitles('not-cached')).resolves.toBe(false);
  expect(projects.createProject).not.toHaveBeenCalled();
  expect(projects.mutateProject).not.toHaveBeenCalled();
});

it('does not create a project during a cache miss', async () => {
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? null : undefined
  ));
  const projects = {
    loadProject: vi.fn(),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects });

  await expect(store.loadSubtitles('not-cached')).resolves.toBeNull();
  expect(projects.loadProject).not.toHaveBeenCalled();
  expect(projects.createProject).not.toHaveBeenCalled();
  expect(invokeCommand).toHaveBeenCalledTimes(1);
});

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

it('repairs an alias whose project was removed before creating a replacement', async () => {
  const persistedIndex = {
    schemaVersion: 1,
    activeCacheId: 'cache-id',
    entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 100 }],
  };
  const replacementId = '01890f39-7b62-7c4e-8c9a-000000000204';
  const replacement = {
    metadata: { id: replacementId, name: 'cache-id' },
    stateVersion: 0,
    media: [],
    tracks: [],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? persistedIndex : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValue(null),
    createProject: vi.fn().mockResolvedValue(replacement),
    mutateProject: vi.fn(async (id, reason, mutator) => {
      const candidate = mutator(replacement);
      return { snapshot: { ...candidate, stateVersion: 1 } };
    }),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 300 });

  await store.saveSubtitles('cache-id', [{ start: 0, end: 1, text: 'New' }]);

  expect(projects.createProject).toHaveBeenCalledTimes(1);
  expect(projects.mutateProject).toHaveBeenCalledWith(
    replacementId,
    'Save cached subtitles',
    expect.any(Function),
    { retryOnConflict: true }
  );
});

it('commits a namespaced editor revision from the exact expected durable track', async () => {
  let current = snapshot(3, [track()]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 0,
      diverged: false,
      canUndo: false,
      canRedo: false,
      undoReason: null,
      redoReason: null,
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
          historyVersion: 1,
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

  const result = await store.commitEditorRevision(
    'cache-id',
    [{ id: 1, start: 1.25, end: 2.5, text: 'Stored' }],
    [{ id: 1, start: 1.25, end: 2.5, text: 'Edited' }],
    'OSG lyrics editor v1: text'
  );

  expect(current.tracks[0].cues[0].text).toBe('Edited');
  expect(result.status.undoReason).toBe('OSG lyrics editor v1: text');
  expect(projects.commitProjectTrack).toHaveBeenCalledWith(expect.objectContaining({
    id: PROJECT_ID,
    expectedHistoryVersion: 0,
    reason: 'OSG lyrics editor v1: text',
    beforeTrack: expect.objectContaining({ id: TRACK_ID }),
    afterTrack: expect.objectContaining({ id: TRACK_ID }),
  }));
});

it('commits an unsaved editor baseline and its first edit atomically', async () => {
  let current = snapshot();
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 0,
      diverged: false,
      canUndo: false,
      canRedo: false,
      undoReason: null,
      redoReason: null,
    })),
    commitProjectTrack: vi.fn(async (request) => {
      current = { ...current, stateVersion: 1, tracks: [request.afterTrack] };
      return {
        snapshot: current,
        status: {
          stateVersion: 1,
          historyVersion: 1,
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

  await store.commitEditorRevision(
    'cache-id',
    [{ start: 0, end: 1, text: 'Before' }],
    [{ start: 0, end: 1, text: 'After' }],
    'OSG lyrics editor v1: text'
  );

  expect(projects.commitProjectTrack).toHaveBeenCalledTimes(1);
  const request = projects.commitProjectTrack.mock.calls[0][0];
  expect(request.beforeTrack.cues[0].text).toBe('Before');
  expect(request.afterTrack.cues[0].text).toBe('After');
  expect(request.beforeTrack.id).toBe(request.afterTrack.id);
  expect(current.tracks[0].cues[0].text).toBe('After');
});

// The product command mutates the native alias index atomically. Most tests in this file predate
// that command and intentionally focus on project/track behavior, so this adapter gives their
// existing read/write spy a faithful in-memory native mutation boundary. Dedicated tests below
// exercise reordering and exact-owner removal through the public store API.
const emulateNativeAliasCommands = (legacyInvoke) => {
  let current = null;
  const ensureCurrent = async () => {
    if (current !== null) return current;
    const raw = await legacyInvoke('subtitle_project_index_get', {});
    if (typeof raw === 'string') {
      try { current = JSON.parse(raw); } catch { current = null; }
    } else current = raw;
    if (!current?.entries) current = { schemaVersion: 1, activeCacheId: null, entries: [] };
    current = structuredClone(current);
    return current;
  };
  return vi.fn(async (command, payload) => {
    if (command === 'subtitle_project_index_get') return ensureCurrent();
    if (command === 'subtitle_project_alias_activate') {
      const index = await ensureCurrent();
      const { entry } = payload;
      index.entries = index.entries.filter(candidate => (
        candidate.cacheId !== entry.cacheId && candidate.projectId !== entry.projectId
      ));
      index.entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
      index.entries = index.entries.slice(0, MAX_SUBTITLE_PROJECT_ALIASES - 1);
      index.entries.push({ ...entry });
      index.entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
      index.activeCacheId = entry.cacheId;
      await legacyInvoke('subtitle_project_index_set', { index: structuredClone(index) });
      return structuredClone(index);
    }
    if (command === 'subtitle_project_alias_remove') {
      const index = await ensureCurrent();
      const before = index.entries.length;
      index.entries = index.entries.filter(entry => (
        entry.cacheId !== payload.cacheId || entry.projectId !== payload.expectedProjectId
      ));
      const changed = index.entries.length !== before;
      if (changed && index.activeCacheId === payload.cacheId) index.activeCacheId = null;
      if (changed) {
        await legacyInvoke('subtitle_project_index_set', { index: structuredClone(index) });
      }
      return { changed, index: structuredClone(index) };
    }
    return legacyInvoke(command, payload);
  });
};

const createTestStore = (options) => createSubtitleProjectStore({
  ...options,
  invokeCommand: emulateNativeAliasCommands(options.invokeCommand),
});

it('rebuilds a reset alias from one exact native project without creating or content matching', async () => {
  const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000211';
  const projectB = {
    metadata: { id: PROJECT_B, name: 'same bytes, distinct project' },
    stateVersion: 9,
    media: [{ id: '01890f39-7b62-7c4e-8c9a-000000000212', contentHash: 'same' }],
    tracks: [],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async id => (id === PROJECT_B ? projectB : snapshot())),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 444 });

  await expect(store.adoptExactProjectAlias('cache-id', PROJECT_B)).resolves.toEqual({
    cacheId: 'cache-id', projectId: PROJECT_B, snapshot: projectB,
  });

  expect(projects.createProject).not.toHaveBeenCalled();
  expect(projects.loadProject).toHaveBeenCalledExactlyOnceWith(PROJECT_B);
  expect(invokeCommand).toHaveBeenCalledWith('subtitle_project_index_set', {
    index: {
      schemaVersion: 1,
      activeCacheId: 'cache-id',
      entries: [{ cacheId: 'cache-id', projectId: PROJECT_B, lastOpenedAt: 444 }],
    },
  });
});

it('uses the authoritative native cue identity when rapidly editing an idless inserted row', async () => {
  const blankTrack = {
    ...track(),
    cues: [{
      ...track().cues[0],
      startMs: 0,
      endMs: 2_000,
      text: '',
    }],
  };
  let current = snapshot(6, [blankTrack]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 4,
      diverged: false,
      canUndo: true,
      canRedo: false,
      undoReason: 'OSG lyrics editor v1: insert',
      redoReason: null,
    })),
    commitProjectTrack: vi.fn(async (request) => {
      expect(request.beforeTrack).toEqual(blankTrack);
      expect(request.beforeTrack.cues[0].id).toBe(CUE_ID);
      current = {
        ...current,
        stateVersion: 7,
        tracks: [request.afterTrack],
      };
      return {
        snapshot: current,
        status: {
          stateVersion: 7,
          historyVersion: 5,
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

  await store.commitEditorRevision(
    'cache-id',
    [{ start: 0, end: 2, text: '' }],
    [{ start: 0, end: 2, text: 'A manually created subtitle' }],
    'OSG lyrics editor v1: text'
  );

  expect(projects.commitProjectTrack).toHaveBeenCalledOnce();
  expect(current.tracks[0].cues[0].text).toBe('A manually created subtitle');
});

it('rebinds shifted local ordinals across insert and a following edit', async () => {
  const cueIds = [
    '01890f39-7b62-7c4e-8c9a-000000000211',
    '01890f39-7b62-7c4e-8c9a-000000000212',
    '01890f39-7b62-7c4e-8c9a-000000000213',
  ];
  const insertedId = '01890f39-7b62-7c4e-8c9a-000000000214';
  const initialRows = [
    { id: 1, start: 0, end: 1, text: 'A' },
    { id: 2, start: 2, end: 3, text: 'B' },
    { id: 3, start: 4, end: 5, text: 'C' },
  ];
  const insertedRows = [
    initialRows[0],
    { id: insertedId, start: 1, end: 2, text: '' },
    initialRows[1],
    initialRows[2],
  ];
  const initialTrack = {
    id: TRACK_ID,
    label: SUBTITLE_CACHE_TRACK_LABEL,
    origin: 'legacyJson',
    cues: initialRows.map((row, index) => ({
      id: cueIds[index],
      ordinal: index + 1,
      startMs: row.start * 1_000,
      endMs: row.end * 1_000,
      text: row.text,
      sourceId: null,
    })),
  };
  let current = snapshot(3, [initialTrack]);
  let historyVersion = 0;
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion,
      diverged: false,
      canUndo: historyVersion > 0,
      canRedo: false,
      undoReason: historyVersion > 0 ? 'OSG lyrics editor v1: insert' : null,
      redoReason: null,
    })),
    commitProjectTrack: vi.fn(async (request) => {
      expect(request.beforeTrack).toEqual(current.tracks[0]);
      historyVersion += 1;
      current = {
        ...current,
        stateVersion: current.stateVersion + 1,
        tracks: [request.afterTrack],
      };
      return {
        snapshot: current,
        status: {
          stateVersion: current.stateVersion,
          historyVersion,
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

  await store.commitEditorRevision(
    'cache-id', initialRows, insertedRows, 'OSG lyrics editor v1: insert'
  );
  expect(current.tracks[0].cues.map((cue) => cue.id)).toEqual([
    cueIds[0], insertedId, cueIds[1], cueIds[2],
  ]);

  const editedRows = insertedRows.map((row, index) => (
    index === 3 ? { ...row, text: 'C edited after the insert' } : row
  ));
  await store.commitEditorRevision(
    'cache-id', insertedRows, editedRows, 'OSG lyrics editor v1: text'
  );

  expect(projects.commitProjectTrack).toHaveBeenCalledTimes(2);
  expect(current.tracks[0].cues.map((cue) => cue.id)).toEqual([
    cueIds[0], insertedId, cueIds[1], cueIds[2],
  ]);
  expect(current.tracks[0].cues[3].text).toBe('C edited after the insert');
});

it('maps a genuine native track conflict to authoritative subtitle rows', async () => {
  const current = snapshot(8, [track()]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 3,
      diverged: false,
      canUndo: true,
      canRedo: false,
      undoReason: 'OSG lyrics editor v1: insert',
      redoReason: null,
    })),
    commitProjectTrack: vi.fn(async () => {
      const error = new Error('native CAS refused a newer writer');
      error.code = 'staleProjectVersion';
      error.authoritativeSnapshot = current;
      throw error;
    }),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });

  await expect(store.commitEditorRevision(
    'cache-id',
    [{ id: 1, start: 1.25, end: 2.5, text: 'Stored' }],
    [{ id: 1, start: 1.25, end: 2.5, text: 'Edited' }],
    'OSG lyrics editor v1: text'
  )).rejects.toMatchObject({
    code: 'subtitleHistoryDiverged',
    authoritativeRows: [{ id: 1, start: 1.25, end: 2.5, text: 'Stored' }],
  });
});

it('bootstraps before deleting an unsaved last row even though the empty root matches the result', async () => {
  let current = snapshot();
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 0,
      diverged: false,
      canUndo: false,
      canRedo: false,
      undoReason: null,
      redoReason: null,
    })),
    commitProjectTrack: vi.fn(async (request) => ({
      snapshot: current,
      status: {
        stateVersion: current.stateVersion,
        historyVersion: 1,
        diverged: false,
        canUndo: true,
        canRedo: false,
        undoReason: request.reason,
        redoReason: null,
      },
    })),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });

  await store.commitEditorRevision(
    'cache-id',
    [{ start: 0, end: 1, text: 'Only row' }],
    [],
    'OSG lyrics editor v1: delete'
  );

  expect(projects.commitProjectTrack).toHaveBeenCalledTimes(1);
  expect(projects.commitProjectTrack).toHaveBeenCalledWith(expect.objectContaining({
    beforeTrack: expect.objectContaining({
      cues: [expect.objectContaining({ text: 'Only row' })],
    }),
    afterTrack: null,
  }));
  expect(current.tracks).toEqual([]);
});

it('refuses a stale same-track overwrite and returns only canonical authoritative rows', async () => {
  const current = snapshot(8, [track()]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: current.stateVersion,
      historyVersion: 0,
      diverged: false,
      canUndo: false,
      canRedo: false,
      undoReason: null,
      redoReason: null,
    })),
    commitProjectTrack: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });

  await expect(store.commitEditorRevision(
    'cache-id',
    [{ start: 0, end: 1, text: 'Stale local' }],
    [{ start: 0, end: 1, text: 'Overwrite' }],
    'OSG lyrics editor v1: text'
  )).rejects.toMatchObject({
    code: 'subtitleHistoryDiverged',
    authoritativeRows: [{ id: 1, start: 1.25, end: 2.5, text: 'Stored' }],
  });
  expect(projects.commitProjectTrack).not.toHaveBeenCalled();
});

it('represents deletion of the last row by removing the canonical track', async () => {
  let current = snapshot(3, [track()]);
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => ({
      stateVersion: 3,
      historyVersion: 0,
      diverged: false,
      canUndo: false,
      canRedo: false,
      undoReason: null,
      redoReason: null,
    })),
    commitProjectTrack: vi.fn(async (request) => {
      current = { ...current, stateVersion: 4, tracks: [] };
      return {
        snapshot: current,
        status: {
          stateVersion: 4,
          historyVersion: 1,
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

  await store.commitEditorRevision(
    'cache-id',
    [{ id: 1, start: 1.25, end: 2.5, text: 'Stored' }],
    [],
    'OSG lyrics editor v1: delete'
  );
  expect(current.tracks).toEqual([]);
});

it('passes the independent cursor version and reason through guarded navigation', async () => {
  const current = snapshot(9, [track()]);
  const parentTrack = {
    ...track(),
    cues: [{ ...track().cues[0], text: 'Parent' }],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? existingIndex() : undefined
  ));
  const status = {
    stateVersion: 9,
    historyVersion: 4,
    diverged: false,
    canUndo: true,
    canRedo: false,
    undoReason: 'OSG lyrics editor v1: text',
    redoReason: null,
  };
  const projects = {
    loadProject: vi.fn(async () => current),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
    getProjectTrackHistoryStatus: vi.fn(async () => status),
    undoProjectTrack: vi.fn(async () => ({
      snapshot: { ...current, stateVersion: 10, tracks: [parentTrack] },
      status: {
        ...status,
        stateVersion: 10,
        historyVersion: 5,
        canUndo: false,
        canRedo: true,
        undoReason: null,
        redoReason: 'OSG lyrics editor v1: text',
      },
    })),
    redoProjectTrack: vi.fn(),
  };
  const store = createTestStore({ invokeCommand, projects, now: () => 200 });

  await expect(store.undoEditorRevision(
    'cache-id',
    4,
    'OSG lyrics editor v1: text'
  )).resolves.toMatchObject({
    rows: [{ id: 1, start: 1.25, end: 2.5, text: 'Parent' }],
    status: { historyVersion: 5, canRedo: true },
  });
  expect(projects.undoProjectTrack).toHaveBeenCalledWith({
    id: PROJECT_ID,
    selector: { label: SUBTITLE_CACHE_TRACK_LABEL, origin: 'legacyJson' },
    expectedHistoryVersion: 4,
    expectedReason: 'OSG lyrics editor v1: text',
  });
});

it('uses the same UTF-16 and Unicode control-character cache bounds as native storage', async () => {
  const invokeCommand = vi.fn(async (command) => (
    command === 'subtitle_project_index_get' ? null : undefined
  ));
  const store = createTestStore({
    invokeCommand,
    projects: {
      loadProject: vi.fn(),
      createProject: vi.fn(),
      mutateProject: vi.fn(),
    },
  });

  await expect(store.resolveProjectForCache('😀'.repeat(4_096), { create: false }))
    .resolves.toBeNull();
  expect(() => store.resolveProjectForCache(`${'😀'.repeat(4_096)}x`, { create: false }))
    .toThrow(expect.objectContaining({ code: 'invalidCacheId' }));
  expect(() => store.resolveProjectForCache('cache\u0085id', { create: false }))
    .toThrow(expect.objectContaining({ code: 'invalidCacheId' }));
});
