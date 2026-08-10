import {
  createSubtitleProjectStore,
  SUBTITLE_CACHE_TRACK_LABEL,
  SUBTITLE_PROJECT_INDEX_KEY,
} from './subtitleProjectStore';

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

it('creates a project alias once and commits cache rows through the project mutation queue', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'setting_get') return null;
    if (command === 'setting_set') return undefined;
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 123 });

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
  expect(projects.createProject).toHaveBeenCalledWith('cache-id');
  expect(invokeCommand).toHaveBeenCalledWith('setting_set', {
    key: SUBTITLE_PROJECT_INDEX_KEY,
    value: {
      schemaVersion: 1,
      activeCacheId: 'cache-id',
      entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 123 }],
    },
  });
});

it('loads seconds-based rows from an existing canonical cache project', async () => {
  const persistedIndex = {
    schemaVersion: 1,
    activeCacheId: 'cache-id',
    entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 100 }],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'setting_get' ? persistedIndex : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValue(snapshot(3, [track()])),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

  await expect(store.loadSubtitles('cache-id')).resolves.toEqual([
    { id: 1, start: 1.25, end: 2.5, text: 'Stored' },
  ]);
  expect(projects.createProject).not.toHaveBeenCalled();
  expect(projects.loadProject).toHaveBeenCalledWith(PROJECT_ID);
});

it('clears only the cached subtitle track through an optimistic project revision', async () => {
  const persistedIndex = {
    schemaVersion: 1,
    activeCacheId: 'cache-id',
    entries: [{ cacheId: 'cache-id', projectId: PROJECT_ID, lastOpenedAt: 100 }],
  };
  const invokeCommand = vi.fn(async (command) => (
    command === 'setting_get' ? persistedIndex : undefined
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

  await expect(store.clearSubtitles('cache-id')).resolves.toBe(true);
  expect(projects.mutateProject).toHaveBeenCalledTimes(1);
  expect(projects.createProject).not.toHaveBeenCalled();
});

it('does not create or commit a project when clearing a cache miss', async () => {
  const invokeCommand = vi.fn(async (command) => (
    command === 'setting_get' ? null : undefined
  ));
  const projects = {
    loadProject: vi.fn(),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createSubtitleProjectStore({ invokeCommand, projects });

  await expect(store.clearSubtitles('not-cached')).resolves.toBe(false);
  expect(projects.createProject).not.toHaveBeenCalled();
  expect(projects.mutateProject).not.toHaveBeenCalled();
});

it('does not create a project during a cache miss', async () => {
  const invokeCommand = vi.fn(async (command) => (
    command === 'setting_get' ? null : undefined
  ));
  const projects = {
    loadProject: vi.fn(),
    createProject: vi.fn(),
    mutateProject: vi.fn(),
  };
  const store = createSubtitleProjectStore({ invokeCommand, projects });

  await expect(store.loadSubtitles('not-cached')).resolves.toBeNull();
  expect(projects.loadProject).not.toHaveBeenCalled();
  expect(projects.createProject).not.toHaveBeenCalled();
  expect(invokeCommand).toHaveBeenCalledTimes(1);
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
    command === 'setting_get' ? persistedIndex : undefined
  ));
  const projects = {
    loadProject: vi.fn().mockResolvedValue(null),
    createProject: vi.fn().mockResolvedValue(replacement),
    mutateProject: vi.fn(async (id, reason, mutator) => {
      const candidate = mutator(replacement);
      return { snapshot: { ...candidate, stateVersion: 1 } };
    }),
  };
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 300 });

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
    command === 'setting_get' ? existingIndex() : undefined
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

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
    command === 'setting_get' ? existingIndex() : undefined
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

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

it('bootstraps before deleting an unsaved last row even though the empty root matches the result', async () => {
  let current = snapshot();
  const invokeCommand = vi.fn(async (command) => (
    command === 'setting_get' ? existingIndex() : undefined
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

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
    command === 'setting_get' ? existingIndex() : undefined
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

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
    command === 'setting_get' ? existingIndex() : undefined
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

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
    command === 'setting_get' ? existingIndex() : undefined
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
  const store = createSubtitleProjectStore({ invokeCommand, projects, now: () => 200 });

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
