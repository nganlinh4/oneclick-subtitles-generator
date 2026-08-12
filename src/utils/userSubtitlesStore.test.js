import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import {
  clearUserProvidedSubtitles,
  getCurrentCacheId,
  getUserProvidedSubtitles,
  getUserProvidedSubtitlesSync,
  setCurrentCacheId,
  setUserProvidedSubtitles,
  subscribeCurrentCacheId,
} from './userSubtitlesStore';

vi.mock('../platform/projectAuxiliaryStore', () => ({
  patchProjectAuxiliary: vi.fn(),
  readProjectAuxiliary: vi.fn(),
}));

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
