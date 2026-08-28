import { act, renderHook } from '@testing-library/react';

import { useLyricsEditorDrag } from './useLyricsEditorDrag';

// Drives one drag frame the way LyricItem's pointer handlers do: a mousedown records the start
// value, then a single pointer move reports an absolute clientX. `handleDrag` derives its own
// delta as `clientX - startX` at a fixed 0.01 s/px scale, so passing `startX: 0` lets a test give
// `handleDrag` a plain seconds-to-pixels value directly.
const drag = (result, index, field, startValue, deltaSeconds, duration) => {
  act(() => result.current.startDrag(index, field, 0, startValue));
  act(() => result.current.handleDrag(Math.round(deltaSeconds / 0.01), duration));
};

const setupDrag = (lyrics, isSticky) => {
  const setLyrics = vi.fn();
  const onUpdateLyrics = vi.fn();
  const commitLyricsMutation = vi.fn();
  const { result } = renderHook(() => useLyricsEditorDrag({
    lyrics,
    setLyrics,
    onUpdateLyrics,
    commitLyricsMutation,
    isSticky,
  }));
  return { result, setLyrics };
};

beforeEach(() => {
  // The hook throttles updates against `performance.now()`; fix it far past the 30ms window so
  // every drag in these tests takes the immediate (non-rAF-throttled) path deterministically.
  vi.spyOn(window.performance, 'now').mockReturnValue(10_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useLyricsEditorDrag sticky cascade vs. media duration', () => {
  it('clamps the cascade delta so no cue crosses media duration, preserving relative spacing', () => {
    const lyrics = [
      { id: 'a', start: 0, end: 2, text: 'a' },
      { id: 'b', start: 3, end: 4, text: 'b' },
      { id: 'c', start: 5, end: 6, text: 'c' },
    ];
    const { result, setLyrics } = setupDrag(lyrics, true);

    // Drag cue "a"'s end far past media duration (10s) while sticky cascades "b" and "c" too.
    drag(result, 0, 'end', lyrics[0].end, 10, 8);

    expect(setLyrics).toHaveBeenCalledTimes(1);
    const updated = setLyrics.mock.calls[0][0];
    expect(updated.map((l) => [l.start, l.end])).toEqual([[0, 4], [5, 6], [7, 8]]);
    // The invariant this regression protects: no cue may end beyond real media duration.
    expect(Math.max(...updated.map((l) => l.end))).toBeLessThanOrEqual(8);
    // Every cue shifted by the same clamped delta, so the gaps between them are unchanged.
    expect(updated[1].start - updated[0].end).toBeCloseTo(1);
    expect(updated[2].start - updated[1].end).toBeCloseTo(1);
  });

  it('is a no-op once the cascade already sits exactly at the media boundary', () => {
    const lyrics = [
      { id: 'a', start: 0, end: 2, text: 'a' },
      { id: 'b', start: 3, end: 5, text: 'b' }, // already at duration
    ];
    const { result, setLyrics } = setupDrag(lyrics, true);

    // A small further forward drag on "a" would still be well inside "a"'s own duration bound,
    // but the cascade's trailing cue ("b") has no room left before real media duration.
    drag(result, 0, 'end', lyrics[0].end, 0.5, 5);

    expect(setLyrics).not.toHaveBeenCalled();
  });

  it('also clamps a forward start-field cascade, not just the dragged cue\'s own field', () => {
    const lyrics = [
      { id: 'a', start: 0, end: 1, text: 'a' },
      { id: 'b', start: 2, end: 3, text: 'b' },
    ];
    const { result, setLyrics } = setupDrag(lyrics, true);

    // A huge forward start drag: with sticky on, the dragged cue's own start has no independent
    // upper clamp (only the cascade delta clamp added here bounds it).
    drag(result, 0, 'start', lyrics[0].start, 100, 5);

    const updated = setLyrics.mock.calls[0][0];
    expect(Math.max(...updated.map((l) => l.end))).toBeLessThanOrEqual(5);
  });
});
