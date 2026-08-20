import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';
import {
  clearTranscriptionRules,
  getTranscriptionRules,
  getTranscriptionRulesSync,
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
  await expect(getTranscriptionRules()).resolves.toEqual(persisted);
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

it('clears media A rules synchronously and ignores its stale direct read after switching to B', async () => {
  setCurrentCacheId(null);
  readProjectAuxiliary.mockReset();
  readProjectAuxiliary.mockResolvedValueOnce({ transcriptionRules: null });
  setCurrentCacheId('asset-a');
  await Promise.resolve();

  const oldRead = {};
  oldRead.promise = new Promise((resolve) => { oldRead.resolve = resolve; });
  const newHydration = {};
  newHydration.promise = new Promise((resolve) => { newHydration.resolve = resolve; });
  readProjectAuxiliary
    .mockReturnValueOnce(oldRead.promise)
    .mockReturnValueOnce(newHydration.promise);
  const stale = getTranscriptionRules();
  const updates = [];
  const onUpdate = (event) => updates.push(event.detail.rules);
  window.addEventListener('transcriptionRulesUpdated', onUpdate);

  setCurrentCacheId('asset-b');
  expect(updates.at(-1)).toBeNull();
  expect(getTranscriptionRulesSync()).toBeNull();

  oldRead.resolve({ transcriptionRules: { media: 'A' } });
  await expect(stale).resolves.toBeNull();
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
  await expect(getTranscriptionRules()).resolves.toEqual({ atmosphere: 'saved' });

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
