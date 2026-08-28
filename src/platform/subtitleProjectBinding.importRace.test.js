// Reuses the mocking shape from subtitleProjectBinding.test.js (mocking only the modules that
// would otherwise reach into Tauri IPC) so this exercises the real activateSubtitleProjectBinding /
// awaitSubtitleProjectBindingSettled pairing against a realistic in-flight activation, rather than
// a hand-rolled stand-in for the race described in the FileUploadInput -> subtitleProjectBinding ->
// importedSubtitlePersistence chain.
const mocks = vi.hoisted(() => ({
  bindRules: vi.fn(),
  bindSubtitles: vi.fn(),
  currentCacheId: null,
  refresh: vi.fn(),
  resolve: vi.fn(),
  rollbackRules: vi.fn(),
  rollbackSubtitles: vi.fn(),
  setRulesCache: vi.fn(),
  setSubtitlesCache: vi.fn(),
  activateProject: vi.fn(),
  releaseProject: vi.fn(),
  activeSnapshot: null,
  restoreActiveSnapshot: vi.fn(),
  deactivateProject: vi.fn(),
}));

vi.mock('./subtitleProjectStore', () => ({ resolveProjectForCache: mocks.resolve }));
vi.mock('./mediaProjectActivation', () => ({
  activateResolvedMediaProject: mocks.activateProject,
}));
vi.mock('./projectService', () => ({
  activateProjectSnapshot: mocks.restoreActiveSnapshot,
  deactivateProject: mocks.deactivateProject,
  getActiveProjectSnapshot: () => mocks.activeSnapshot,
}));
vi.mock('../utils/transcriptionRulesStore', () => ({
  bindTranscriptionRulesProject: mocks.bindRules,
  isTranscriptionRulesProjectBindingReceipt: (value, scope) => (
    value?.kind === 'rules' && value.cacheId === scope.cacheId && value.projectId === scope.projectId
  ),
  rollbackTranscriptionRulesProjectBinding: mocks.rollbackRules,
  getCurrentCacheId: () => mocks.currentCacheId,
  setCurrentCacheId: mocks.setRulesCache,
}));
vi.mock('../utils/userSubtitlesStore', () => ({
  bindUserSubtitlesProject: mocks.bindSubtitles,
  getCurrentCacheId: () => mocks.currentCacheId,
  isUserSubtitlesProjectBindingReceipt: (value, scope) => (
    value?.kind === 'subtitles'
    && value.cacheId === scope.cacheId
    && value.projectId === scope.projectId
  ),
  refreshCurrentSubtitleProject: mocks.refresh,
  rollbackUserSubtitlesProjectBinding: mocks.rollbackSubtitles,
  setCurrentCacheId: mocks.setSubtitlesCache,
}));

import { activateSubtitleProjectBinding } from './subtitleProjectBinding';
import { createImportedSubtitlePersistence } from '../utils/importedSubtitlePersistence';

const rows = [{ id: 1, start: 0, end: 1, text: 'hello' }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentCacheId = 'cache-old';
  mocks.activeSnapshot = null;
  mocks.resolve.mockResolvedValue({
    cacheId: 'cache-new',
    projectId: 'project-new',
    snapshot: {
      media: [],
      metadata: { id: 'project-new', name: 'Fixture' },
      stateVersion: 1,
      tracks: [],
    },
  });
  mocks.releaseProject.mockReturnValue(true);
  mocks.activateProject.mockResolvedValue({ release: mocks.releaseProject });
  mocks.bindRules.mockResolvedValue({ kind: 'rules', cacheId: 'cache-new', projectId: 'project-new' });
  mocks.rollbackRules.mockImplementation((value) => value?.kind === 'rules');
  mocks.rollbackSubtitles.mockImplementation((value) => value?.kind === 'subtitles');
});

it('an SRT drop that lands while its media is still binding waits, then publishes into the new project', async () => {
  // bindUserSubtitlesProject flips the store's cache ID to the new project synchronously, well
  // before the activation as a whole is durable -- this is the exact early flip
  // importedSubtitlePersistence.js used to treat as ground truth mid-flight.
  let settleBindSubtitles;
  mocks.bindSubtitles.mockImplementationOnce((cacheId, { expectedProjectId }) => {
    mocks.currentCacheId = cacheId;
    return new Promise((resolve) => {
      settleBindSubtitles = () => resolve({ kind: 'subtitles', cacheId, projectId: expectedProjectId });
    });
  });

  const activation = activateSubtitleProjectBinding('cache-new', { expectedProjectId: 'project-new' });

  await vi.waitFor(() => expect(mocks.bindSubtitles).toHaveBeenCalled());
  // The store already reports the new media as current, but the activation has not settled.
  expect(mocks.currentCacheId).toBe('cache-new');

  const save = vi.fn(async () => ({
    success: true, cacheId: 'cache-new', projectId: 'project-new', subtitleCount: rows.length,
  }));
  const persist = createImportedSubtitlePersistence({
    desktop: () => true,
    readCacheId: () => mocks.currentCacheId,
    resolveProject: mocks.resolve,
    save,
  });

  const pending = persist(rows);
  await Promise.resolve();
  await Promise.resolve();
  // The activation is still unsettled; the import must not act on the cache ID it just observed.
  expect(save).not.toHaveBeenCalled();

  settleBindSubtitles();
  await expect(activation).resolves.toMatchObject({ cacheId: 'cache-new', projectId: 'project-new' });

  await expect(pending).resolves.toMatchObject({
    cacheId: 'cache-new', projectId: 'project-new', subtitleCount: rows.length,
  });
  expect(save).toHaveBeenCalledWith('cache-new', rows, { expectedProjectId: 'project-new' });
});
