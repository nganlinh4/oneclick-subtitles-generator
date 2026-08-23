import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';
import {
  bindUserSubtitlesProject,
  clearUserProvidedSubtitles,
  getCurrentCacheId,
  getUserProvidedSubtitles,
  getUserProvidedSubtitlesSync,
  isUserSubtitlesProjectBindingReceipt,
  setCurrentCacheId,
  setUserProvidedSubtitles,
  setUserProvidedSubtitlesForCache,
  subscribeCurrentCacheId,
  refreshCurrentSubtitleProject,
  subscribeCurrentSubtitleProjectRefresh,
} from './userSubtitlesStore';

vi.mock('../platform/projectAuxiliaryStore', () => ({
  patchProjectAuxiliary: vi.fn(),
  readProjectAuxiliary: vi.fn(),
}));
vi.mock('../platform/subtitleProjectStore', () => ({ resolveProjectForCache: vi.fn() }));

it('hydrates and persists user subtitle text natively without localhost or localStorage', async () => {
  readProjectAuxiliary.mockResolvedValue({ userSubtitles: 'Persisted reference' });
  patchProjectAuxiliary.mockResolvedValue({ userSubtitles: 'Edited reference' });
  global.fetch = vi.fn();
  const storageGet = vi.spyOn(Storage.prototype, 'getItem');
  const storageSet = vi.spyOn(Storage.prototype, 'setItem');

  setCurrentCacheId('cache-id');
  await expect(getUserProvidedSubtitles()).resolves.toBe('Persisted reference');
  expect(getUserProvidedSubtitlesSync()).toBe('Persisted reference');

  await setUserProvidedSubtitles('Edited reference');
  expect(patchProjectAuxiliary).toHaveBeenCalledWith('cache-id', {
    userSubtitles: 'Edited reference',
  });
  await clearUserProvidedSubtitles();
  expect(patchProjectAuxiliary).toHaveBeenLastCalledWith('cache-id', {
    userSubtitles: null,
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(storageGet).not.toHaveBeenCalled();
  expect(storageSet).not.toHaveBeenCalled();

  storageGet.mockRestore();
  storageSet.mockRestore();
});

it('publishes cache identity changes exactly once and supports disposal', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeCurrentCacheId(listener);
  const previousCacheId = getCurrentCacheId();
  setCurrentCacheId('next-cache-id');
  setCurrentCacheId('next-cache-id');
  expect(listener).toHaveBeenCalledExactlyOnceWith('next-cache-id', previousCacheId);

  unsubscribe();
  setCurrentCacheId(null);
  expect(listener).toHaveBeenCalledTimes(1);
});

it('publishes same-alias project refreshes separately from identity changes', () => {
  setCurrentCacheId('same-project');
  const identity = vi.fn();
  const refresh = vi.fn();
  const unsubscribeIdentity = subscribeCurrentCacheId(identity);
  const unsubscribeRefresh = subscribeCurrentSubtitleProjectRefresh(refresh);

  refreshCurrentSubtitleProject('same-project');

  expect(refresh).toHaveBeenCalledExactlyOnceWith('same-project');
  expect(identity).not.toHaveBeenCalled();
  expect(() => refreshCurrentSubtitleProject('other-project'))
    .toThrow(expect.objectContaining({ code: 'projectScopeMismatch' }));
  unsubscribeIdentity();
  unsubscribeRefresh();
  setCurrentCacheId(null);
});

it('clears media A auxiliary text synchronously while media B hydrates', async () => {
  readProjectAuxiliary.mockReset();
  readProjectAuxiliary.mockResolvedValueOnce({ userSubtitles: null });
  setCurrentCacheId('asset-a');
  await Promise.resolve();
  await setUserProvidedSubtitles('Media A reference');

  const pending = {};
  pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
  readProjectAuxiliary.mockReturnValueOnce(pending.promise);
  const updates = [];
  const onUpdate = (event) => updates.push(event.detail.subtitlesText);
  window.addEventListener('userProvidedSubtitlesUpdated', onUpdate);

  setCurrentCacheId('asset-b');
  expect(updates.at(-1)).toBe('');
  expect(getUserProvidedSubtitlesSync()).toBe('');

  pending.resolve({ userSubtitles: 'Media B reference' });
  await pending.promise;
  await Promise.resolve();
  expect(updates.at(-1)).toBe('Media B reference');
  expect(getUserProvidedSubtitlesSync()).toBe('Media B reference');

  window.removeEventListener('userProvidedSubtitlesUpdated', onUpdate);
  setCurrentCacheId(null);
});

it('does not cache an old direct read after the cache identity changes', async () => {
  readProjectAuxiliary.mockReset();
  readProjectAuxiliary.mockResolvedValueOnce({ userSubtitles: null });
  setCurrentCacheId('asset-a');
  await Promise.resolve();

  const pending = {};
  pending.promise = new Promise((resolve) => { pending.resolve = resolve; });
  const newHydration = {};
  newHydration.promise = new Promise((resolve) => { newHydration.resolve = resolve; });
  readProjectAuxiliary
    .mockReturnValueOnce(pending.promise)
    .mockReturnValueOnce(newHydration.promise);
  const stale = getUserProvidedSubtitles();
  setCurrentCacheId('asset-b');
  pending.resolve({ userSubtitles: 'Stale media A reference' });

  await expect(stale).resolves.toBe('');
  expect(getUserProvidedSubtitlesSync()).toBe('');
  newHydration.resolve({ userSubtitles: 'Media B reference' });
  await newHydration.promise;
  await Promise.resolve();
  expect(getUserProvidedSubtitlesSync()).toBe('Media B reference');
  setCurrentCacheId(null);
});

it('rolls back the in-memory subtitle reference when native persistence fails', async () => {
  readProjectAuxiliary.mockReset();
  readProjectAuxiliary.mockResolvedValue({ userSubtitles: 'Saved reference' });
  setCurrentCacheId('rollback-user-subtitles');
  await expect(getUserProvidedSubtitles()).resolves.toBe('Saved reference');

  patchProjectAuxiliary.mockRejectedValueOnce(new Error('native write failed'));
  await expect(setUserProvidedSubtitles('Unsaved reference'))
    .rejects.toThrow('native write failed');
  expect(getUserProvidedSubtitlesSync()).toBe('Saved reference');
  setCurrentCacheId(null);
});

it('publishes no subtitle state when the cache alias remaps after its scoped native write', async () => {
  setCurrentCacheId(null);
  readProjectAuxiliary.mockReset();
  readProjectAuxiliary.mockResolvedValue({ userSubtitles: null });
  setCurrentCacheId('post-write-user-cache');
  await Promise.resolve();
  patchProjectAuxiliary.mockResolvedValueOnce({ userSubtitles: 'Stale reference' });
  resolveProjectForCache
    .mockResolvedValueOnce({ projectId: 'project-before' })
    .mockResolvedValueOnce({ projectId: 'project-after-remap' });
  const published = vi.fn();
  window.addEventListener('userProvidedSubtitlesUpdated', published);

  await expect(setUserProvidedSubtitlesForCache(
    'post-write-user-cache',
    'Stale reference',
    { expectedProjectId: 'project-before' }
  )).rejects.toMatchObject({ code: 'projectScopeMismatch' });

  expect(getUserProvidedSubtitlesSync()).toBe('');
  expect(published).not.toHaveBeenCalled();
  window.removeEventListener('userProvidedSubtitlesUpdated', published);
  setCurrentCacheId(null);
});

it('refuses the legacy fire-and-forget transfer for subtitles staged before media', async () => {
  setCurrentCacheId(null);
  patchProjectAuxiliary.mockClear();
  await setUserProvidedSubtitles('1\n00:00:00,000 --> 00:00:01,000\nStaged');

  expect(() => setCurrentCacheId('legacy-unscoped-cache')).toThrow(expect.objectContaining({
    code: 'projectBindingRequired',
  }));
  expect(patchProjectAuxiliary).not.toHaveBeenCalled();
  expect(getUserProvidedSubtitlesSync()).toContain('Staged');

  await setUserProvidedSubtitles(null);
});

it('publishes staged subtitles only after an exact-project durable binding receipt', async () => {
  setCurrentCacheId(null);
  await setUserProvidedSubtitles('Durable SRT');
  resolveProjectForCache.mockReset();
  resolveProjectForCache.mockResolvedValue({ projectId: 'project-a' });
  let releaseWrite;
  patchProjectAuxiliary.mockReturnValueOnce(new Promise((resolve) => { releaseWrite = resolve; }));
  const published = vi.fn();
  window.addEventListener('userProvidedSubtitlesUpdated', published);

  const pending = bindUserSubtitlesProject('cache-a', {
    expectedProjectId: 'project-a',
  });
  await vi.waitFor(() => expect(patchProjectAuxiliary).toHaveBeenCalledExactlyOnceWith(
    'cache-a',
    { userSubtitles: 'Durable SRT' },
    { expectedProjectId: 'project-a' }
  ));
  expect(published).not.toHaveBeenCalled();

  releaseWrite({ userSubtitles: 'Durable SRT' });
  const receipt = await pending;
  expect(isUserSubtitlesProjectBindingReceipt(receipt, {
    cacheId: 'cache-a',
    projectId: 'project-a',
  })).toBe(true);
  expect(published).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    detail: {
      subtitlesText: 'Durable SRT',
      cacheId: 'cache-a',
      projectId: 'project-a',
    },
  }));

  window.removeEventListener('userProvidedSubtitlesUpdated', published);
  setCurrentCacheId(null);
});

it('restores staged subtitles and rejects when the alias remaps after the write', async () => {
  setCurrentCacheId(null);
  await setUserProvidedSubtitles('Still staged');
  resolveProjectForCache.mockReset();
  resolveProjectForCache
    .mockResolvedValueOnce({ projectId: 'project-a' })
    .mockResolvedValueOnce({ projectId: 'project-b' });
  patchProjectAuxiliary.mockResolvedValueOnce({ userSubtitles: 'Still staged' });
  const published = vi.fn();
  window.addEventListener('userProvidedSubtitlesUpdated', published);

  await expect(bindUserSubtitlesProject('cache-remapped', {
    expectedProjectId: 'project-a',
  })).rejects.toMatchObject({ code: 'projectScopeMismatch' });
  expect(getUserProvidedSubtitlesSync()).toBe('Still staged');
  expect(published).not.toHaveBeenCalledWith(expect.objectContaining({
    detail: expect.objectContaining({
      subtitlesText: 'Still staged',
      cacheId: 'cache-remapped',
      projectId: 'project-a',
    }),
  }));

  window.removeEventListener('userProvidedSubtitlesUpdated', published);
  await setUserProvidedSubtitles(null);
});
