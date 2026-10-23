import { act, renderHook } from '@testing-library/react';
import { flushDurableLyricsHistory } from '../platform/durableLyricsHistory';
import { saveSubtitlesToCache } from '../services/subtitleCache';
import { useLyricsSave } from './useLyricsSave';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('../platform/durableLyricsHistory', () => ({
  flushDurableLyricsHistory: vi.fn(),
}));


vi.mock('../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: vi.fn(() => 'cache-id'),
}));

vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(),
  saveSubtitlesToCache: vi.fn(),
}));

it('surfaces a manual save refusal through one translated keyed toast', async () => {
  flushDurableLyricsHistory.mockRejectedValue(new Error('private native detail'));
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.addToast = vi.fn();
  const { result, unmount } = renderHook(() => useLyricsSave({
    lyrics: [{ id: 1, start: 0, end: 1, text: 'Unsaved edit' }],
    updateSavedLyrics: vi.fn(),
    onSaveSubtitles: vi.fn(),
  }));

  await act(async () => {
    await expect(result.current.handleSave()).resolves.toBe(false);
  });

  expect(window.addToast).toHaveBeenCalledExactlyOnceWith(
    'The subtitles could not be saved. Please try again.',
    'error',
    8_000,
    'subtitle-save-failed',
  );
  expect(saveSubtitlesToCache).not.toHaveBeenCalled();
  unmount();
  consoleError.mockRestore();
});
