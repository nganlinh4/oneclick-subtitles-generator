import { renderHook, waitFor } from '@testing-library/react';

import { loadProjectNarration } from '../../../platform/projectNarrationStore';
import useNarrationCache from './useNarrationCache';

const projectMocks = vi.hoisted(() => ({
  getActiveProjectSnapshot: vi.fn(),
  subscribeToActiveProject: vi.fn(() => () => undefined),
}));

vi.mock('../../../platform/projectNarrationStore', () => ({
  loadProjectNarration: vi.fn(),
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
  source: 'original',
  results: [{
    subtitle_id: 1,
    text: 'restored',
    success: true,
    nativeArtifactId: ARTIFACT_ID,
    filename: `osg-speech-artifact:${ARTIFACT_ID}`,
    start: 0,
    end: 1,
  }],
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
  localStorage.clear();
  projectMocks.getActiveProjectSnapshot.mockReturnValue(snapshot(7));
  projectMocks.subscribeToActiveProject.mockReturnValue(() => undefined);
});

test('hydrates only the native narration record for the exact active revision', async () => {
  loadProjectNarration.mockResolvedValue(stored(7));
  const harness = mount();

  await waitFor(() => expect(harness.setGenerationResults).toHaveBeenCalledWith(
    stored(7).results,
  ));
  expect(harness.setGenerationStatus).toHaveBeenCalledWith(
    'Loaded narrations from previous session',
  );
});

test('discards a late native read after the active project revision advances', async () => {
  let resolveLoad;
  loadProjectNarration.mockReturnValue(new Promise((resolve) => { resolveLoad = resolve; }));
  const harness = mount();
  await waitFor(() => expect(loadProjectNarration).toHaveBeenCalledWith(PROJECT_ID));

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
  loadProjectNarration.mockResolvedValue(null);
  const harness = mount();

  await waitFor(() => expect(loadProjectNarration).toHaveBeenCalled());
  expect(getItem).not.toHaveBeenCalled();
  expect(harness.setGenerationResults).not.toHaveBeenCalled();
  getItem.mockRestore();
});
