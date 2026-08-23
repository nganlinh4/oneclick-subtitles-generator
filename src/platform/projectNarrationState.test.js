import { act, renderHook } from '@testing-library/react';

import {
  adoptProjectNarrationAuthority,
  clearCurrentProjectNarrationState,
  getAllCurrentProjectNarrationResults,
  getCurrentProjectNarrationResults,
  getCurrentProjectNarrationState,
  publishProjectNarrationGrouping,
  publishProjectNarrationResults,
  useProjectNarrationState,
} from './projectNarrationState';

const projectMocks = vi.hoisted(() => ({
  active: null,
  subscribers: new Set(),
}));

vi.mock('./projectService', () => ({
  getActiveProjectSnapshot: () => projectMocks.active,
  subscribeToActiveProject: (subscriber) => {
    projectMocks.subscribers.add(subscriber);
    return () => projectMocks.subscribers.delete(subscriber);
  },
}));

const PROJECT_A = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';
const PROJECT_B = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a5';
const active = (projectId, stateVersion) => {
  projectMocks.active = { metadata: { id: projectId }, stateVersion };
  [...projectMocks.subscribers].forEach((subscriber) => subscriber(projectMocks.active));
};

beforeEach(() => {
  projectMocks.subscribers.clear();
  projectMocks.active = { metadata: { id: PROJECT_A }, stateVersion: 1 };
  adoptProjectNarrationAuthority(projectMocks.active);
  clearCurrentProjectNarrationState();
});

test('keeps original translated and grouped results distinct under one exact authority', () => {
  const original = [{ subtitle_id: 1, text: 'original' }];
  const translated = [{ subtitle_id: 1, text: 'translated' }];
  const grouped = [{ subtitle_id: 'group-1', text: 'grouped' }];

  publishProjectNarrationResults({
    projectId: PROJECT_A, projectStateVersion: 1, source: 'original', results: original,
  });
  publishProjectNarrationResults({
    projectId: PROJECT_A, projectStateVersion: 1, source: 'translated', results: translated,
  });
  publishProjectNarrationResults({
    projectId: PROJECT_A, projectStateVersion: 1, source: 'grouped', results: grouped,
  });
  publishProjectNarrationGrouping({
    projectId: PROJECT_A,
    projectStateVersion: 1,
    enabled: true,
    groupedCues: [{ id: 'group-1', start: 0, end: 1, text: 'grouped' }],
    baseSource: 'translated',
  });

  expect(getCurrentProjectNarrationState()).toMatchObject({
    projectId: PROJECT_A,
    projectStateVersion: 1,
    activeSource: 'grouped',
    resultsBySource: { original, translated, grouped },
  });
  expect(getCurrentProjectNarrationResults()).toEqual(grouped);
  expect(getAllCurrentProjectNarrationResults()).toEqual([
    ...original, ...translated, ...grouped,
  ]);
});

test('a revision advance makes every prior result invisible before any writer runs', () => {
  publishProjectNarrationResults({
    projectId: PROJECT_A,
    projectStateVersion: 1,
    source: 'original',
    results: [{ subtitle_id: 1 }],
  });

  active(PROJECT_A, 2);

  expect(getCurrentProjectNarrationState()).toMatchObject({
    projectId: PROJECT_A,
    projectStateVersion: 2,
    activeSource: 'original',
  });
  expect(getCurrentProjectNarrationResults()).toEqual([]);
  expect(publishProjectNarrationResults({
    projectId: PROJECT_A,
    projectStateVersion: 1,
    source: 'original',
    results: [{ subtitle_id: 2 }],
  })).toBe(false);
});

test('a project switch cannot expose or accept another projects results', () => {
  publishProjectNarrationResults({
    projectId: PROJECT_A,
    projectStateVersion: 1,
    source: 'translated',
    results: [{ subtitle_id: 1 }],
  });
  active(PROJECT_B, 0);

  expect(getCurrentProjectNarrationState().projectId).toBe(PROJECT_B);
  expect(getAllCurrentProjectNarrationResults()).toEqual([]);
  expect(publishProjectNarrationResults({
    projectId: PROJECT_A,
    projectStateVersion: 1,
    source: 'translated',
    results: [{ subtitle_id: 2 }],
  })).toBe(false);
});

test('React subscribers update on narration publication and project invalidation', () => {
  const { result } = renderHook(() => useProjectNarrationState());
  act(() => {
    publishProjectNarrationResults({
      projectId: PROJECT_A,
      projectStateVersion: 1,
      source: 'original',
      results: [{ subtitle_id: 1 }],
    });
  });
  expect(result.current.resultsBySource.original).toEqual([{ subtitle_id: 1 }]);

  act(() => active(PROJECT_A, 2));
  expect(result.current.projectStateVersion).toBe(2);
  expect(result.current.resultsBySource.original).toEqual([]);

  act(() => clearCurrentProjectNarrationState());
  expect(result.current.resultsBySource.original).toEqual([]);
});
