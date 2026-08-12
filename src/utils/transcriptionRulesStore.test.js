import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import {
  clearTranscriptionRules,
  getTranscriptionRules,
  getTranscriptionRulesSync,
  setCurrentCacheId,
  setTranscriptionRules,
} from './transcriptionRulesStore';

vi.mock('../platform/projectAuxiliaryStore', () => ({
  patchProjectAuxiliary: vi.fn(),
  readProjectAuxiliary: vi.fn(),
}));

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
