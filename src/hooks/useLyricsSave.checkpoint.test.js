import { renderHook } from '@testing-library/react';
import { checkpointBeforeUpdate } from '../services/lifecycleOrchestrator';
import { useLyricsSave } from './useLyricsSave';

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
  save: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('../platform/desktopRuntime', () => ({
  isDesktopRuntime: () => true,
}));

vi.mock('../platform/durableLyricsHistory', () => ({
  flushDurableLyricsHistory: mocks.flush,
}));

vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(),
  saveSubtitlesToCache: mocks.save,
}));

vi.mock('../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: () => 'cache-id',
}));

const rows = [{ id: 1, start: 0, end: 1, text: 'Manual edit' }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flush.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({ success: true });
  window.addToast = vi.fn();
});

it('echoes the checkpoint identity and resolves after a successful durable save', async () => {
  const updateSavedLyrics = vi.fn();
  const onSaveSubtitles = vi.fn();
  const { unmount } = renderHook(() => useLyricsSave({
    lyrics: rows,
    updateSavedLyrics,
    onSaveSubtitles,
  }));

  await expect(checkpointBeforeUpdate({
    source: 'segment-processing-start',
    segment: { start: 0, end: 1 },
    runId: 'run-1',
  }, 100)).resolves.toBeUndefined();

  expect(mocks.flush).toHaveBeenCalledTimes(1);
  expect(mocks.save).toHaveBeenCalledWith('cache-id', rows);
  expect(updateSavedLyrics).toHaveBeenCalledTimes(1);
  expect(onSaveSubtitles).toHaveBeenCalledWith(rows);
  unmount();
});

it('rejects the checkpoint and never saves when the durable flush fails', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.flush.mockRejectedValue(new Error('C:\\private\\native-secret.txt'));
  const updateSavedLyrics = vi.fn();
  const { unmount } = renderHook(() => useLyricsSave({
    lyrics: rows,
    updateSavedLyrics,
    onSaveSubtitles: vi.fn(),
  }));

  const checkpoint = checkpointBeforeUpdate({ source: 'video-processing-complete' }, 100);
  await expect(checkpoint).rejects.toMatchObject({
    code: 'checkpointSaveFailed',
    message: 'The subtitle checkpoint could not be saved',
  });
  await checkpoint.catch((error) => {
    expect(String(error)).not.toContain('private');
    expect(String(error)).not.toContain('native-secret');
  });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(updateSavedLyrics).not.toHaveBeenCalled();
  consoleError.mockRestore();
  unmount();
});
