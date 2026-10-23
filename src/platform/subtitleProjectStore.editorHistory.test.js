// subtitleProjectStore: editor revisions, native cue identity rebinding and guarded navigation.

import { SUBTITLE_CACHE_TRACK_LABEL } from './subtitleProjectStore';
import {
  PROJECT_ID,
  TRACK_ID,
  CUE_ID,
  snapshot,
  track,
  existingIndex,
  createTestStore,
} from './subtitleProjectStoreTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

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
