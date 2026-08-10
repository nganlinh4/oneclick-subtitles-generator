import { act, renderHook, waitFor } from '@testing-library/react';
import { EVENTS, publish } from '../events/bus';
import { flushDurableLyricsHistory } from '../platform/durableLyricsHistory';
import { saveSubtitlesToCache } from '../services/subtitleCache';
import { useLyricsSave } from './useLyricsSave';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('../platform/durableLyricsHistory', () => ({
  flushDurableLyricsHistory: vi.fn(),
}));

vi.mock('../platform/desktopRuntime', () => ({
  isDesktopRuntime: vi.fn(() => true),
}));

vi.mock('../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: vi.fn(() => 'cache-id'),
}));

vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(),
  saveSubtitlesToCache: vi.fn(),
}));

it('fails a keyed checkpoint without persisting rejected optimistic rows', async () => {
  const error = Object.assign(new Error('private native detail'), {
    code: 'historyQueueSaturated',
  });
  flushDurableLyricsHistory.mockRejectedValue(error);
  const updateSavedLyrics = vi.fn();
  const onSaveSubtitles = vi.fn();
  const completed = vi.fn();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.addToast = vi.fn();
  window.addEventListener(EVENTS.SAVE_COMPLETE, completed);
  renderHook(() => useLyricsSave({
    lyrics: [{ id: 1, start: 0, end: 1, text: 'Rejected optimistic text' }],
    updateSavedLyrics,
    onSaveSubtitles,
  }));

  act(() => publish(EVENTS.SAVE_BEFORE_UPDATE, {
    source: 'segment-processing-start',
    checkpointId: 'checkpoint-7',
  }));
  await waitFor(() => expect(completed).toHaveBeenCalledTimes(1));

  expect(completed.mock.calls[0][0].detail).toEqual({
    source: 'segment-processing-start',
    checkpointId: 'checkpoint-7',
    success: false,
  });
  expect(saveSubtitlesToCache).not.toHaveBeenCalled();
  expect(updateSavedLyrics).not.toHaveBeenCalled();
  expect(onSaveSubtitles).not.toHaveBeenCalled();
  expect(window.addToast).not.toHaveBeenCalled();

  window.removeEventListener(EVENTS.SAVE_COMPLETE, completed);
  consoleError.mockRestore();
});
