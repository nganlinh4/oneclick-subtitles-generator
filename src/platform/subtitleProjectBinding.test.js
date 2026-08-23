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

import {
  activateSubtitleProjectBinding,
  clearSubtitleProjectBinding,
  isSubtitleProjectBindingReceipt,
  rollbackSubtitleProjectBinding,
} from './subtitleProjectBinding';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentCacheId = null;
  mocks.activeSnapshot = null;
  mocks.resolve.mockResolvedValue({
    cacheId: 'cache-a',
    projectId: 'project-a',
    snapshot: {
      media: [],
      metadata: { id: 'project-a', name: 'Fixture' },
      stateVersion: 7,
      tracks: [],
    },
  });
  mocks.releaseProject.mockReturnValue(true);
  mocks.activateProject.mockResolvedValue({ release: mocks.releaseProject });
  mocks.bindRules.mockResolvedValue({ kind: 'rules', cacheId: 'cache-a', projectId: 'project-a' });
  mocks.bindSubtitles.mockResolvedValue({
    kind: 'subtitles', cacheId: 'cache-a', projectId: 'project-a',
  });
  mocks.rollbackRules.mockImplementation((value) => value?.kind === 'rules');
  mocks.rollbackSubtitles.mockImplementation((value) => value?.kind === 'subtitles');
});

it('returns success only after both exact-project stores and the alias are durable', async () => {
  let releaseRules;
  mocks.bindRules.mockReturnValueOnce(new Promise((resolve) => { releaseRules = resolve; }));
  let settled = false;
  const pending = activateSubtitleProjectBinding('cache-a').then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(mocks.bindSubtitles).toHaveBeenCalled());
  expect(settled).toBe(false);
  releaseRules({ kind: 'rules', cacheId: 'cache-a', projectId: 'project-a' });

  const receipt = await pending;
  expect(isSubtitleProjectBindingReceipt(receipt, {
    cacheId: 'cache-a',
    projectId: 'project-a',
  })).toBe(true);
  expect(mocks.resolve).toHaveBeenNthCalledWith(1, 'cache-a', { create: true });
  expect(mocks.resolve).toHaveBeenNthCalledWith(2, 'cache-a', { create: false });
  expect(mocks.activateProject).toHaveBeenCalledWith(expect.objectContaining({
    projectId: 'project-a',
  }), { validateOwnership: expect.any(Function) });
});

it('clears only the exact active project binding captured by a media release', () => {
  mocks.currentCacheId = 'cache-a';
  mocks.activeSnapshot = { metadata: { id: 'project-a' } };

  expect(clearSubtitleProjectBinding({
    expectedCacheId: 'cache-b',
    expectedProjectId: 'project-a',
  })).toBe(false);
  expect(clearSubtitleProjectBinding({
    expectedCacheId: 'cache-a',
    expectedProjectId: 'project-b',
  })).toBe(false);
  expect(mocks.setRulesCache).not.toHaveBeenCalled();
  expect(mocks.setSubtitlesCache).not.toHaveBeenCalled();

  expect(clearSubtitleProjectBinding({
    expectedCacheId: 'cache-a',
    expectedProjectId: 'project-a',
  })).toBe(true);
  expect(mocks.setRulesCache).toHaveBeenCalledExactlyOnceWith(null);
  expect(mocks.setSubtitlesCache).toHaveBeenCalledExactlyOnceWith(null);
});

it('rolls back the sibling binding and never issues a receipt when one store fails', async () => {
  const previous = {
    media: [],
    metadata: { id: 'project-previous', name: 'Previous' },
    stateVersion: 4,
    tracks: [],
  };
  mocks.activeSnapshot = previous;
  const rulesReceipt = { kind: 'rules', cacheId: 'cache-a', projectId: 'project-a' };
  mocks.bindRules.mockResolvedValueOnce(rulesReceipt);
  mocks.bindSubtitles.mockRejectedValueOnce(new Error('subtitle write failed'));

  await expect(activateSubtitleProjectBinding('cache-a')).rejects.toThrow('subtitle write failed');
  expect(mocks.rollbackRules).toHaveBeenCalledExactlyOnceWith(rulesReceipt);
  expect(mocks.releaseProject).toHaveBeenCalledOnce();
  expect(mocks.restoreActiveSnapshot).toHaveBeenCalledExactlyOnceWith(previous);
  expect(mocks.resolve).toHaveBeenCalledTimes(1);
});

it('rejects a project remap after both writes and rolls both bindings back', async () => {
  const rulesReceipt = { kind: 'rules', cacheId: 'cache-a', projectId: 'project-a' };
  const subtitlesReceipt = { kind: 'subtitles', cacheId: 'cache-a', projectId: 'project-a' };
  mocks.bindRules.mockResolvedValueOnce(rulesReceipt);
  mocks.bindSubtitles.mockResolvedValueOnce(subtitlesReceipt);
  mocks.resolve
    .mockResolvedValueOnce({
      cacheId: 'cache-a',
      projectId: 'project-a',
      snapshot: { media: [], metadata: { id: 'project-a', name: 'A' }, stateVersion: 7, tracks: [] },
    })
    .mockResolvedValueOnce({
      cacheId: 'cache-a',
      projectId: 'project-b',
      snapshot: { media: [], metadata: { id: 'project-b', name: 'B' }, stateVersion: 1, tracks: [] },
    });

  await expect(activateSubtitleProjectBinding('cache-a')).rejects.toMatchObject({
    code: 'subtitleProjectBindingFailed',
  });
  expect(mocks.rollbackRules).toHaveBeenCalledWith(rulesReceipt);
  expect(mocks.rollbackSubtitles).toHaveBeenCalledWith(subtitlesReceipt);
});

it('a failed media transaction restores the previous active project only while it owns the receipt', async () => {
  const previous = {
    media: [],
    metadata: { id: 'project-previous', name: 'Previous' },
    stateVersion: 4,
    tracks: [],
  };
  mocks.activeSnapshot = previous;
  const receipt = await activateSubtitleProjectBinding('cache-a');
  mocks.activeSnapshot = {
    media: [{ id: 'candidate' }],
    metadata: { id: 'project-a', name: 'Candidate' },
    stateVersion: 8,
    tracks: [],
  };

  expect(rollbackSubtitleProjectBinding(receipt)).toBe(true);
  expect(mocks.rollbackRules).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rules' }));
  expect(mocks.rollbackSubtitles).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'subtitles' })
  );
  expect(mocks.restoreActiveSnapshot).toHaveBeenCalledExactlyOnceWith(previous);
  expect(rollbackSubtitleProjectBinding(receipt)).toBe(false);
});
