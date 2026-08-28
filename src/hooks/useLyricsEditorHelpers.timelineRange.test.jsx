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

// Regression for the timelineAdvancedEditing journey: a cue spanning nearly the whole video (here
// clamped to exactly the media span by an earlier start/end drag, matching the real evidence)
// visibly OVERLAPS any range the customer drags a move-together selection over, even though only
// the two cues fully inside that selection were ever dragged into it. A range move must translate
// only the cues actually inside the selection -- moving the wide cue's un-selected portion along
// with it is not what the customer selected.
it('range-moves only the cues fully inside the selection, not a cue that merely overlaps it', () => {
  const lyrics = [
    { id: 1, start: 0, end: 19.010, text: 'Interior cue for direct start and end drag tests' },
    { id: 2, start: 3.0, end: 4.0, text: 'First cue of the move-together range' },
    { id: 3, start: 4.5, end: 5.5, text: 'Second cue of the move-together range' },
    { id: 4, start: 8.0, end: 8.5, text: 'Sticky cascade base cue' },
    { id: 5, start: 9.0, end: 9.5, text: 'Sticky cascade follower cue' },
  ];
  const setLyrics = vi.fn();
  const onUpdateLyrics = vi.fn();
  const commitLyricsMutation = vi.fn();
  const { result } = renderHook(() => useLyricsEditorHelpers({
    lyrics,
    setLyrics,
    onUpdateLyrics,
    commitLyricsMutation,
  }));

  // Matches the journey's real pointer-dragged selection [2.7, 6.3] around cues 2 and 3, then an
  // overshoot delta clamped by the selected range's own bounds against a ~19.01s media duration.
  act(() => {
    result.current.beginRangeMove(2.7, 6.3);
    result.current.previewRangeMove(12.71);
    result.current.commitRangeMove();
  });

  expect(commitLyricsMutation).toHaveBeenCalledTimes(1);
  const [committedRows, action] = commitLyricsMutation.mock.calls[0];
  expect(action).toBe(LYRICS_EDITOR_ACTIONS.MOVE_RANGE);

  // The wide interior cue was never inside the selection: it must stay exactly where it started.
  expect(committedRows[0].start).toBeCloseTo(0, 5);
  expect(committedRows[0].end).toBeCloseTo(19.010, 5);
  // The two move-together cues were fully inside the selection: both shift by the same delta.
  expect(committedRows[1].start).toBeCloseTo(3.0 + 12.71, 5);
  expect(committedRows[2].start).toBeCloseTo(4.5 + 12.71, 5);
  // Cues outside the selection entirely are untouched.
  expect(committedRows[3].start).toBeCloseTo(8.0, 5);
  expect(committedRows[4].start).toBeCloseTo(9.0, 5);
});

