import { renderHook, waitFor } from '@testing-library/react';

import { loadProjectNarrations } from '../../../platform/projectNarrationStore';
import { getCurrentProjectNarrationResults } from '../../../platform/projectNarrationState';
import useNarrationCache from './useNarrationCache';

const projectMocks = vi.hoisted(() => ({
  getActiveProjectSnapshot: vi.fn(),
  subscribers: new Set(),
  subscribeToActiveProject: vi.fn((subscriber) => {
    projectMocks.subscribers.add(subscriber);
    return () => projectMocks.subscribers.delete(subscriber);
  }),
}));

vi.mock('../../../platform/projectNarrationStore', () => ({
  loadProjectNarrations: vi.fn(),
}));
vi.mock('../../../platform/projectService', () => ({
  getActiveProjectSnapshot: projectMocks.getActiveProjectSnapshot,
  subscribeToActiveProject: projectMocks.subscribeToActiveProject,
}));
vi.mock('../../../platform/nativeNarrationAdapter', () => ({
  nativeNarrationAdapter: {
    getReference: vi.fn(async () => null),
    releasePlayback: vi.fn(async () => true),
    commitReference: vi.fn(),
  },
}));
vi.mock('../../../platform/jobResultDeliveryService', () => ({
  acknowledgeJobResult: vi.fn(),
}));

const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const snapshot = (stateVersion) => ({
  metadata: { id: PROJECT_ID, name: 'Narration project' },
  stateVersion,
  media: [],
  tracks: [],
});
const stored = (projectStateVersion) => ({
  projectId: PROJECT_ID,
  projectStateVersion,
  resultsBySource: { original: [{
    subtitle_id: 1,
    text: 'restored',
    success: true,
    nativeArtifactId: ARTIFACT_ID,
    filename: `osg-speech-artifact:${ARTIFACT_ID}`,
    start: 0,
    end: 1,
  }], translated: [], grouped: [] },
});

const mount = () => {
  const setGenerationResults = vi.fn();
  const setGenerationStatus = vi.fn();
  renderHook(() => useNarrationCache({
    generationResults: [],
    setGenerationResults,
    setGenerationStatus,
    subtitleSource: 'original',
    t: (_key, fallback) => fallback,
    setReferenceAudio: vi.fn(),
    setReferenceText: vi.fn(),
  }));
  return { setGenerationResults, setGenerationStatus };
};

beforeEach(() => {
  vi.clearAllMocks();
  projectMocks.subscribers.clear();
  localStorage.clear();
  projectMocks.getActiveProjectSnapshot.mockReturnValue(snapshot(7));
});

test('hydrates only the native narration record for the exact active revision', async () => {
  loadProjectNarrations.mockResolvedValue(stored(7));
  const harness = mount();

  await waitFor(() => expect(harness.setGenerationResults).toHaveBeenCalledWith(
    stored(7).resultsBySource.original,
  ));
  expect(harness.setGenerationStatus).toHaveBeenCalledWith(
    'Loaded narrations from previous session',
  );
});

test('hydrates all source buckets while displaying only the selected source', async () => {
  const all = stored(7);
  all.resultsBySource.translated = [{
    ...all.resultsBySource.original[0],
    subtitle_id: 2,
    text: 'translated',
  }];
  all.resultsBySource.grouped = [{
    ...all.resultsBySource.original[0],
    subtitle_id: 'group-1',
    text: 'grouped',
  }];
  loadProjectNarrations.mockResolvedValue(all);
  const harness = mount();

  await waitFor(() => expect(harness.setGenerationResults).toHaveBeenCalledWith(
    all.resultsBySource.original,
  ));
  expect(getCurrentProjectNarrationResults('translated')).toEqual(
    all.resultsBySource.translated,
  );
  expect(getCurrentProjectNarrationResults('grouped')).toEqual(all.resultsBySource.grouped);
});

test('clears visible results synchronously when exact project authority advances', async () => {
  loadProjectNarrations.mockResolvedValueOnce(stored(7));
  const harness = mount();
  await waitFor(() => expect(harness.setGenerationResults).toHaveBeenCalledWith(
    stored(7).resultsBySource.original,
  ));
  harness.setGenerationResults.mockClear();
  loadProjectNarrations.mockResolvedValue(null);

  projectMocks.getActiveProjectSnapshot.mockReturnValue(snapshot(8));
  projectMocks.subscribers.forEach((subscriber) => subscriber(snapshot(8)));

  expect(harness.setGenerationResults).toHaveBeenCalledWith([]);
  expect(getCurrentProjectNarrationResults('original')).toEqual([]);
});

test('discards a late native read after the active project revision advances', async () => {
  let resolveLoad;
  loadProjectNarrations.mockReturnValue(new Promise((resolve) => { resolveLoad = resolve; }));
  const harness = mount();
  await waitFor(() => expect(loadProjectNarrations).toHaveBeenCalledWith(PROJECT_ID));

  projectMocks.getActiveProjectSnapshot.mockReturnValue(snapshot(8));
  resolveLoad(stored(7));
  await Promise.resolve();
  await Promise.resolve();

  expect(harness.setGenerationResults).not.toHaveBeenCalled();
  expect(harness.setGenerationStatus).not.toHaveBeenCalled();
});

test('never revives legacy browser narration caches', async () => {
  localStorage.setItem('gemini_narration_cache', JSON.stringify({
    privateMediaId: 'stale',
    audioData: 'legacy-base64',
  }));
  const getItem = vi.spyOn(Storage.prototype, 'getItem');
  loadProjectNarrations.mockResolvedValue(null);
  const harness = mount();

  await waitFor(() => expect(loadProjectNarrations).toHaveBeenCalled());
  expect(getItem).not.toHaveBeenCalled();
  expect(harness.setGenerationResults).not.toHaveBeenCalled();
  getItem.mockRestore();
});
