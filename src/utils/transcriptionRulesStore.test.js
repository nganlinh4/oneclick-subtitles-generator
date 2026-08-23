import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';
import {
  bindTranscriptionRulesProject,
  clearTranscriptionRules,
  commitVideoAnalysisForCache,
  getTranscriptionRulesSync,
  isTranscriptionRulesProjectBindingReceipt,
  setCurrentCacheId,
  setTranscriptionRules,
  setTranscriptionRulesForCache,
} from './transcriptionRulesStore';

vi.mock('../platform/projectAuxiliaryStore', () => ({
  patchProjectAuxiliary: vi.fn(),
  readProjectAuxiliary: vi.fn(),
}));
vi.mock('../platform/subtitleProjectStore', () => ({ resolveProjectForCache: vi.fn() }));

it('hydrates and persists transcription rules through native project auxiliary storage', async () => {
  const persisted = { atmosphere: 'quiet' };
  const edited = { atmosphere: 'busy', terminology: [] };
  readProjectAuxiliary.mockResolvedValue({ transcriptionRules: persisted });
  patchProjectAuxiliary.mockResolvedValue({ transcriptionRules: edited });
  global.fetch = vi.fn();
  const storageGet = vi.spyOn(Storage.prototype, 'getItem');
  const storageSet = vi.spyOn(Storage.prototype, 'setItem');

  setCurrentCacheId('cache-id');
  await vi.waitFor(() => expect(getTranscriptionRulesSync()).toEqual(persisted));
  expect(getTranscriptionRulesSync()).toEqual(persisted);

  await setTranscriptionRules(edited);
  expect(patchProjectAuxiliary).toHaveBeenCalledWith('cache-id', {
    transcriptionRules: edited,
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(storageGet).not.toHaveBeenCalled();
  expect(storageSet).not.toHaveBeenCalled();

  await clearTranscriptionRules();
  expect(patchProjectAuxiliary).toHaveBeenLastCalledWith('cache-id', {
    transcriptionRules: null,
  });

  storageGet.mockRestore();
  storageSet.mockRestore();
});

it('clears media A rules synchronously and ignores its stale hydration after switching to B', async () => {
  setCurrentCacheId(null);
  readProjectAuxiliary.mockReset();
  const oldRead = {};
  oldRead.promise = new Promise((resolve) => { oldRead.resolve = resolve; });
  const newHydration = {};
  newHydration.promise = new Promise((resolve) => { newHydration.resolve = resolve; });
  readProjectAuxiliary
    .mockReturnValueOnce(oldRead.promise)
    .mockReturnValueOnce(newHydration.promise);
  const updates = [];
  const onUpdate = (event) => updates.push(event.detail.rules);
  window.addEventListener('transcriptionRulesUpdated', onUpdate);

  setCurrentCacheId('asset-a');
  setCurrentCacheId('asset-b');
  expect(updates.at(-1)).toBeNull();
  expect(getTranscriptionRulesSync()).toBeNull();

  oldRead.resolve({ transcriptionRules: { media: 'A' } });
  await oldRead.promise;
  await Promise.resolve();
  expect(getTranscriptionRulesSync()).toBeNull();

  newHydration.resolve({ transcriptionRules: { media: 'B' } });
  await newHydration.promise;
  await Promise.resolve();
  expect(updates.at(-1)).toEqual({ media: 'B' });
  expect(getTranscriptionRulesSync()).toEqual({ media: 'B' });

  window.removeEventListener('transcriptionRulesUpdated', onUpdate);
  setCurrentCacheId(null);
});

it('rolls back the in-memory rules when native project persistence fails', async () => {
  setCurrentCacheId(null);
  readProjectAuxiliary.mockReset();
  readProjectAuxiliary.mockResolvedValue({ transcriptionRules: { atmosphere: 'saved' } });
  setCurrentCacheId('rollback-rules');
  await vi.waitFor(() => expect(getTranscriptionRulesSync()).toEqual({ atmosphere: 'saved' }));

  patchProjectAuxiliary.mockRejectedValueOnce(new Error('native write failed'));
  await expect(setTranscriptionRules({ atmosphere: 'unsaved' }))
    .rejects.toThrow('native write failed');
  expect(getTranscriptionRulesSync()).toEqual({ atmosphere: 'saved' });
  setCurrentCacheId(null);
});

it('publishes no rules when the cache alias remaps after its scoped native write', async () => {
  setCurrentCacheId(null);
  readProjectAuxiliary.mockReset();
  readProjectAuxiliary.mockResolvedValue({ transcriptionRules: null });
  setCurrentCacheId('post-write-rules-cache');
  await Promise.resolve();
  patchProjectAuxiliary.mockResolvedValueOnce({ transcriptionRules: { atmosphere: 'stale' } });
  resolveProjectForCache
    .mockResolvedValueOnce({ projectId: 'project-before' })
    .mockResolvedValueOnce({ projectId: 'project-after-remap' });
  const published = vi.fn();
  window.addEventListener('transcriptionRulesUpdated', published);

  await expect(setTranscriptionRulesForCache(
    'post-write-rules-cache',
    { atmosphere: 'stale' },
    { expectedProjectId: 'project-before' }
  )).rejects.toMatchObject({ code: 'projectScopeMismatch' });

  expect(getTranscriptionRulesSync()).toBeNull();
  expect(published).not.toHaveBeenCalled();
  window.removeEventListener('transcriptionRulesUpdated', published);
  setCurrentCacheId(null);
});

it('publishes the exact cache and project scope after a scoped native write', async () => {
  setCurrentCacheId(null);
  readProjectAuxiliary.mockResolvedValue({ transcriptionRules: null });
  setCurrentCacheId('scoped-rules-cache');
  await Promise.resolve();
  resolveProjectForCache.mockResolvedValue({ projectId: 'scoped-project' });
  patchProjectAuxiliary.mockResolvedValue({ transcriptionRules: { atmosphere: 'quiet' } });
  const published = vi.fn();
  window.addEventListener('transcriptionRulesUpdated', published);

  await setTranscriptionRulesForCache(
    'scoped-rules-cache',
    { atmosphere: 'quiet' },
    { expectedProjectId: 'scoped-project' }
  );

  expect(published).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    detail: {
      rules: { atmosphere: 'quiet' },
      cacheId: 'scoped-rules-cache',
      projectId: 'scoped-project',
    },
  }));
  window.removeEventListener('transcriptionRulesUpdated', published);
  setCurrentCacheId(null);
});

it('persists provider analysis and its rules in one exact-project write', async () => {
  setCurrentCacheId(null);
  readProjectAuxiliary.mockResolvedValue({ transcriptionRules: null });
  setCurrentCacheId('analysis-cache');
  await Promise.resolve();
  resolveProjectForCache.mockResolvedValue({ projectId: 'analysis-project' });
  const analysis = {
    schemaVersion: 1,
    sourceIdentity: 'asset:source',
    providerJobId: '01890f39-7b62-7c4e-8c9a-000000000311',
    deliveryId: '01890f39-7b62-7c4e-8c9a-000000000312',
    recommendedPresetId: 'general',
    transcriptionRules: { atmosphere: 'quiet' },
  };
  patchProjectAuxiliary.mockResolvedValue({
    transcriptionRules: analysis.transcriptionRules,
    analysis,
  });

  await expect(commitVideoAnalysisForCache(
    'analysis-cache',
    { rules: analysis.transcriptionRules, analysis },
    { expectedProjectId: 'analysis-project' }
  )).resolves.toMatchObject({
    projectId: 'analysis-project',
    providerJobId: analysis.providerJobId,
    deliveryId: analysis.deliveryId,
  });

  expect(patchProjectAuxiliary).toHaveBeenCalledWith(
    'analysis-cache',
    {
      transcriptionRules: analysis.transcriptionRules,
      analysis,
    },
    { expectedProjectId: 'analysis-project' }
  );
  setCurrentCacheId(null);
});

it('refuses the legacy fire-and-forget transfer for rules staged before media', async () => {
  setCurrentCacheId(null);
  patchProjectAuxiliary.mockClear();
  await setTranscriptionRules({ terminology: ['staged'] });

  expect(() => setCurrentCacheId('legacy-unscoped-cache')).toThrow(expect.objectContaining({
    code: 'projectBindingRequired',
  }));
  expect(patchProjectAuxiliary).not.toHaveBeenCalled();
  expect(getTranscriptionRulesSync()).toEqual({ terminology: ['staged'] });

  await setTranscriptionRules(null);
});

it('publishes staged rules only after an exact-project durable binding receipt', async () => {
  setCurrentCacheId(null);
  await setTranscriptionRules({ terminology: ['durable'] });
  resolveProjectForCache.mockReset();
  resolveProjectForCache.mockResolvedValue({ projectId: 'project-a' });
  let releaseWrite;
  patchProjectAuxiliary.mockReturnValueOnce(new Promise((resolve) => { releaseWrite = resolve; }));
  const published = vi.fn();
  window.addEventListener('transcriptionRulesUpdated', published);

  const pending = bindTranscriptionRulesProject('cache-a', {
    expectedProjectId: 'project-a',
  });
  await vi.waitFor(() => expect(patchProjectAuxiliary).toHaveBeenCalledExactlyOnceWith(
    'cache-a',
    { transcriptionRules: { terminology: ['durable'] } },
    { expectedProjectId: 'project-a' }
  ));
  expect(published).not.toHaveBeenCalled();

  releaseWrite({ transcriptionRules: { terminology: ['durable'] } });
  const receipt = await pending;
  expect(isTranscriptionRulesProjectBindingReceipt(receipt, {
    cacheId: 'cache-a',
    projectId: 'project-a',
  })).toBe(true);
  expect(published).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    detail: {
      rules: { terminology: ['durable'] },
      cacheId: 'cache-a',
      projectId: 'project-a',
    },
  }));

  window.removeEventListener('transcriptionRulesUpdated', published);
  setCurrentCacheId(null);
});

it('restores staged rules and rejects when the alias remaps after the write', async () => {
  setCurrentCacheId(null);
  await setTranscriptionRules({ atmosphere: 'staged' });
  resolveProjectForCache.mockReset();
  resolveProjectForCache
    .mockResolvedValueOnce({ projectId: 'project-a' })
    .mockResolvedValueOnce({ projectId: 'project-b' });
  patchProjectAuxiliary.mockResolvedValueOnce({ transcriptionRules: { atmosphere: 'staged' } });
  const published = vi.fn();
  window.addEventListener('transcriptionRulesUpdated', published);

  await expect(bindTranscriptionRulesProject('cache-remapped', {
    expectedProjectId: 'project-a',
  })).rejects.toMatchObject({ code: 'projectScopeMismatch' });
  expect(getTranscriptionRulesSync()).toEqual({ atmosphere: 'staged' });
  expect(published).not.toHaveBeenCalledWith(expect.objectContaining({
    detail: expect.objectContaining({ cacheId: 'cache-remapped', projectId: 'project-a' }),
  }));

  window.removeEventListener('transcriptionRulesUpdated', published);
  await setTranscriptionRules(null);
});
