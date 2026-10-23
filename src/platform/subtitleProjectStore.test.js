// subtitleProjectStore: alias resolution and repair, cache load/save/clear and cache-ID bounds.

import { SUBTITLE_CACHE_TRACK_LABEL } from './subtitleProjectStore';
import { getActiveTranscript, setActiveTranscript } from './transcriptStore';
import {
  PROJECT_ID,
  snapshot,
  track,
  existingIndex,
  createTestStore,
} from './subtitleProjectStoreTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

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
