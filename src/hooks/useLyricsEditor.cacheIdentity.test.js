import { act, renderHook, waitFor } from '@testing-library/react';
import { useLyricsEditor } from './useLyricsEditor';

let historyOptions;

const historyApi = {
  history: [],
  redoStack: [],
  checkpointHistory: [],
  durableCanUndo: false,
  durableCanRedo: false,
  handleUndo: vi.fn(),
  handleRedo: vi.fn(),
  handleReset: vi.fn(),
  createCheckpoint: vi.fn(),
  handleJumpToCheckpoint: vi.fn(),
  captureStateBeforeMerge: vi.fn(),
  observeExternalLyrics: vi.fn(),
  commitLyricsMutation: vi.fn(),
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('./useLyricsEditorHistory', () => ({
  useLyricsEditorHistory: vi.fn((options) => {
    historyOptions = options;
    return historyApi;
  }),
}));

vi.mock('./useLyricsEditorDrag', () => ({
  useLyricsEditorDrag: () => ({
    startDrag: vi.fn(),
    handleDrag: vi.fn(),
    endDrag: vi.fn(),
    isDragging: false,
    getLastDragEnd: vi.fn(),
  }),
}));

vi.mock('./useLyricsEditorHelpers', () => ({
  useLyricsEditorHelpers: () => ({
    showTranslationWarning: vi.fn(),
    clearSubtitlesInRange: vi.fn(),
    moveSubtitlesInRange: vi.fn(),
    beginRangeMove: vi.fn(),
    previewRangeMove: vi.fn(),
    commitRangeMove: vi.fn(),
    cancelRangeMove: vi.fn(),
  }),
}));

const rows = (text) => [{ id: 1, start: 0, end: 1, text }];

it('does not repopulate reset/save baselines from the prior media while new rows hydrate', async () => {
  const mediaA = rows('Media A');
  const mediaB = rows('Media B');
  const { rerender } = renderHook(
    ({ incoming }) => useLyricsEditor(incoming, vi.fn()),
    { initialProps: { incoming: mediaA } }
  );

  await waitFor(() => expect(historyOptions.savedLyrics).toEqual(mediaA));

  act(() => historyOptions.onCacheIdChange('asset-b', 'asset-a'));
  rerender({ incoming: mediaA });
  expect(historyOptions.savedLyrics).toEqual([]);

  rerender({ incoming: mediaB });
  await waitFor(() => expect(historyOptions.savedLyrics).toEqual(mediaB));
  expect(historyOptions.lyrics).toEqual(mediaB);
});
