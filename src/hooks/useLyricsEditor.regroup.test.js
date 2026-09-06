import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLyricsEditor } from './useLyricsEditor';
import { LYRICS_EDITOR_ACTIONS } from '../platform/durableLyricsHistory';
import { setActiveTranscript, clearActiveTranscript } from '../platform/transcriptStore';

const commitLyricsMutation = vi.fn();

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
  commitLyricsMutation,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('./useLyricsEditorHistory', () => ({
  useLyricsEditorHistory: () => historyApi,
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

describe('useLyricsEditor regrouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveTranscript();
  });

  it('refuses to interpolate words on cue-only captions when no active transcript exists', () => {
    const cueOnlyLyrics = [
      { id: 'c1', text: 'Hello world from an imported SRT cue', start: 1.0, end: 3.5 },
    ];

    const { result } = renderHook(() => useLyricsEditor(cueOnlyLyrics, vi.fn()));

    act(() => {
      result.current.handleRegroup('Natural');
    });

    // Does not call commitLyricsMutation because cue-only captions must remain cue-only
    expect(commitLyricsMutation).not.toHaveBeenCalled();
  });

  it('regroups captions using authentic words from active transcriptStore', () => {
    const cueOnlyLyrics = [
      { id: 'c1', text: 'Hello world', start: 1.0, end: 3.0 },
    ];

    setActiveTranscript({
      projectId: 'proj-1',
      revisionId: 'rev-1',
      words: [
        { id: 'w1', text: 'Hello', startMs: 1000, endMs: 1800 },
        { id: 'w2', text: 'world', startMs: 1900, endMs: 3000 },
      ],
      turns: [],
    });

    const { result } = renderHook(() => useLyricsEditor(cueOnlyLyrics, vi.fn()));

    act(() => {
      result.current.handleRegroup('One word');
    });

    expect(commitLyricsMutation).toHaveBeenCalledTimes(1);
    expect(commitLyricsMutation).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Hello', start: 1.0, end: 1.8 }),
        expect.objectContaining({ text: 'world', start: 1.9, end: 3.0 }),
      ]),
      LYRICS_EDITOR_ACTIONS.REGROUP,
    );
  });
});
