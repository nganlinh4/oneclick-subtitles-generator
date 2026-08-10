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
