import { act, renderHook } from '@testing-library/react';

import { getSelectAllRange } from '../components/lyrics/utils/timelineDomain';
import { LYRICS_EDITOR_ACTIONS } from '../platform/durableLyricsHistory';
import { useLyricsEditorHelpers } from './useLyricsEditorHelpers';

it('clears every cue using the select-all range when the final cue exceeds media', () => {
  const lyrics = [
    { id: 'first', start: 0.5, end: 2, text: 'first' },
    { id: 'last', start: 214.080, end: 216.159, text: 'last' },
  ];
  const commitLyricsMutation = vi.fn();
  const { result } = renderHook(() => useLyricsEditorHelpers({
    lyrics,
    setLyrics: vi.fn(),
    onUpdateLyrics: vi.fn(),
    commitLyricsMutation,
  }));

  const range = getSelectAllRange(lyrics, 214.274);
  act(() => result.current.clearSubtitlesInRange(range.start, range.end));

  expect(commitLyricsMutation).toHaveBeenCalledWith([], LYRICS_EDITOR_ACTIONS.CLEAR_RANGE);
});

