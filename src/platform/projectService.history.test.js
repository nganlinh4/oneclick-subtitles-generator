// projectService: project and per-track history status, track commit and track navigation.

import { createProjectService } from './projectService';
import {
  PROJECT_ID,
  TRACK_SELECTOR,
  snapshot,
  track,
  trackStatus,
} from './projectServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

it('validates bounded history status and detects a cursor that raced the loaded snapshot', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(6, 'Loaded');
    if (command === 'project_history_status') {
      return {
        stateVersion: 6,
        canUndo: true,
        canRedo: false,
        undoReason: 'OSG lyrics editor v1: text',
        redoReason: null,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);
  await expect(service.getProjectHistoryStatus()).resolves.toEqual({
    stateVersion: 6,
    canUndo: true,
    canRedo: false,
    undoReason: 'OSG lyrics editor v1: text',
    redoReason: null,
  });

  let conflictLoadCount = 0;
  invokeCommand.mockImplementation(async (command) => {
    if (command === 'project_history_status') {
      return {
        stateVersion: 7,
        canUndo: true,
        canRedo: false,
        undoReason: 'OSG lyrics editor v1: external merge',
        redoReason: null,
      };
    }
    if (command === 'project_load') {
      conflictLoadCount += 1;
      return conflictLoadCount === 1
        ? snapshot(6, 'Loaded')
        : snapshot(7, 'External edit');
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  await expect(service.getProjectHistoryStatus()).rejects.toEqual(expect.objectContaining({
    name: 'ProjectConflictError',
    authoritativeSnapshot: snapshot(7, 'External edit'),
  }));
});

it('rejects inconsistent, unbounded, and control-bearing project history reasons', async () => {
  const invalidStatuses = [
    {
      stateVersion: 1,
      canUndo: false,
      canRedo: false,
      undoReason: 'edit',
      redoReason: null,
    },
    {
      stateVersion: 1,
      canUndo: true,
      canRedo: false,
      undoReason: 'x'.repeat(501),
      redoReason: null,
    },
    {
      stateVersion: 1,
      canUndo: true,
      canRedo: false,
      undoReason: 'edit\nforged',
      redoReason: null,
    },
  ];

  for (const invalid of invalidStatuses) {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'project_load') return snapshot(1);
      if (command === 'project_history_status') return invalid;
      throw new Error(`Unexpected command: ${command}`);
    });
    const service = createProjectService({ invokeCommand });
    await service.activateProject(PROJECT_ID);
    await expect(service.getProjectHistoryStatus()).rejects.toMatchObject({
      code: 'invalidProjectHistoryStatus',
    });
  }
});

it('refreshes the active project when only the independent track status sees a newer revision', async () => {
  let loadCount = 0;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return snapshot(loadCount <= 2 ? 5 : 6);
    }
    if (command === 'project_track_history_status') {
      return trackStatus(6, 2, 'OSG lyrics editor v1: text');
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  await expect(service.getProjectTrackHistoryStatus(
    PROJECT_ID,
    TRACK_SELECTOR
  )).resolves.toEqual(trackStatus(6, 2, 'OSG lyrics editor v1: text'));
  expect(service.getActiveProjectSnapshot()).toEqual(snapshot(6));
});

it('commits and navigates a track with its independent version and reason guards', async () => {
  const before = track('Before');
  const after = track('After');
  const committedSnapshot = { ...snapshot(8), tracks: [after] };
  const undoneSnapshot = { ...snapshot(9), tracks: [before] };
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(7);
    if (command === 'project_track_commit') {
      return {
        snapshot: committedSnapshot,
        status: trackStatus(8, 4, 'OSG lyrics editor v1: text'),
      };
    }
    if (command === 'project_track_undo') {
      return {
        snapshot: undoneSnapshot,
        status: trackStatus(9, 5, null, 'OSG lyrics editor v1: text'),
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  const committedTrack = await service.commitProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 3,
    beforeTrack: before,
    afterTrack: after,
    reason: 'OSG lyrics editor v1: text',
  });
  const undoneTrack = await service.undoProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 4,
    expectedReason: 'OSG lyrics editor v1: text',
  });
  expect(Object.isFrozen(committedTrack)).toBe(true);
  expect(Object.isFrozen(undoneTrack)).toBe(true);

  expect(invokeCommand).toHaveBeenCalledWith('project_track_commit', {
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 3,
    beforeTrack: before,
    afterTrack: after,
    reason: 'OSG lyrics editor v1: text',
  });
  expect(invokeCommand).toHaveBeenCalledWith('project_track_undo', {
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 4,
    expectedReason: 'OSG lyrics editor v1: text',
  });
  expect(service.getActiveProjectSnapshot()).toEqual(undoneSnapshot);
});

it('reloads authoritative state after a stale independent track writer', async () => {
  let loadCount = 0;
  const authoritative = { ...snapshot(11), tracks: [track('Authoritative')] };
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') {
      loadCount += 1;
      return loadCount <= 2 ? snapshot(10) : authoritative;
    }
    if (command === 'project_track_commit') {
      throw { code: 'staleProjectTrackHistory' };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.activateProject(PROJECT_ID);

  await expect(service.commitProjectTrack({
    id: PROJECT_ID,
    selector: TRACK_SELECTOR,
    expectedHistoryVersion: 1,
    beforeTrack: track('Before'),
    afterTrack: track('After'),
    reason: 'OSG lyrics editor v1: text',
  })).rejects.toMatchObject({
    name: 'ProjectConflictError',
    authoritativeSnapshot: authoritative,
  });
  expect(service.getActiveProjectSnapshot()).toEqual(authoritative);
});

it('rejects a diverged track status that advertises navigation', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'project_load') return snapshot(1);
    if (command === 'project_track_history_status') {
      return {
        ...trackStatus(1, 1, 'OSG lyrics editor v1: text'),
        diverged: true,
      };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const service = createProjectService({ invokeCommand });
  await service.loadProject(PROJECT_ID);
  await expect(service.getProjectTrackHistoryStatus(
    PROJECT_ID,
    TRACK_SELECTOR
  )).rejects.toMatchObject({ code: 'invalidProjectTrackHistoryStatus' });
});
