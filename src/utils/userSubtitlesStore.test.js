import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import {
  clearUserProvidedSubtitles,
  getUserProvidedSubtitles,
  getUserProvidedSubtitlesSync,
  setCurrentCacheId,
  setUserProvidedSubtitles,
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
