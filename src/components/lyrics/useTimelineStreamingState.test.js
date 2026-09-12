import { act, cleanup, renderHook } from '@testing-library/react';
import { EVENTS, publish } from '../../events/bus';
import { useTimelineStreamingState } from './useTimelineStreamingState';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('a previous completion cannot turn off a new streaming run', () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useTimelineStreamingState({ lyrics: [] }));
  act(() => publish(EVENTS.STREAMING_UPDATE, {}));
  act(() => publish(EVENTS.STREAMING_COMPLETE, {}));
  act(() => vi.advanceTimersByTime(500));
  act(() => publish(EVENTS.STREAMING_UPDATE, {}));
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.isStreamingActive).toBe(true);
});

it('tracking a large unchanged stream is linear, and still detects text and timing edits', () => {
  let reads = 0;
  const lyrics = Array.from({ length: 2000 }, (_, index) => ({
    get start() { reads++; return index; }, end: index + 1, text: `Cue ${index}`,
  }));
  const { result, rerender } = renderHook(props => useTimelineStreamingState(props), { initialProps: { lyrics } });
  act(() => publish(EVENTS.STREAMING_UPDATE, {}));
  reads = 0;
  const next = lyrics.slice();
  next[10] = { start: 10, end: 11, text: 'Edited text' };
  next[15] = { start: 15.2, end: 16, text: 'Cue 15' };
  rerender({ lyrics: next });
  expect(result.current.newSegments.size).toBe(2);
  expect(reads).toBeLessThan(lyrics.length * 10);
});
