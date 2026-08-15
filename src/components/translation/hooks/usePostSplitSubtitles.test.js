import { act, renderHook } from '@testing-library/react';
import usePostSplitSubtitles from './usePostSplitSubtitles';

it('derives post-split presentation without replacing or mutating the durable base', () => {
  const base = Object.freeze([Object.freeze({
    id: 1,
    originalId: 'number:1',
    start: 0,
    end: 4,
    text: 'one two three four',
  })]);
  const { result } = renderHook(() => usePostSplitSubtitles({ translatedSubtitles: base }));

  act(() => result.current.setPostSplitMaxWords(2));

  expect(result.current.presentedSubtitles).not.toBe(base);
  expect(result.current.presentedSubtitles.length).toBeGreaterThan(1);
  expect(result.current.presentedSubtitles.every((row) => row.originalId === 'number:1')).toBe(true);
  expect(base).toEqual([{
    id: 1,
    originalId: 'number:1',
    start: 0,
    end: 4,
    text: 'one two three four',
  }]);
});

it('drops project A presentation immediately when the active base is cleared for B', () => {
  const base = [{
    id: 1,
    originalId: 'number:1',
    start: 0,
    end: 2,
    text: 'one two three',
  }];
  const { result, rerender } = renderHook(
    ({ rows }) => usePostSplitSubtitles({ translatedSubtitles: rows }),
    { initialProps: { rows: base } }
  );
  act(() => result.current.setPostSplitMaxWords(1));
  expect(result.current.presentedSubtitles.length).toBeGreaterThan(1);

  rerender({ rows: null });
  expect(result.current.presentedSubtitles).toBeNull();
});
