import { act, renderHook } from '@testing-library/react';

import { useTimelineKeyboardShortcuts } from './useTimelineKeyboardShortcuts';

const createParams = (overrides = {}) => ({
  timelineRef: { current: null },
  renderTimeline: vi.fn(),
  onSegmentSelect: vi.fn(),
  duration: 214.274,
  lyrics: [{ id: 'last', start: 214.080, end: 216.159, text: 'last cue' }],
  disableAutoScroll: { current: false },
  setHasDraggedInSession: vi.fn(),
  setIsDraggingSegment: vi.fn(),
  setDragStartTime: vi.fn(),
  setDragCurrentTime: vi.fn(),
  dragStartRef: { current: null },
  dragCurrentRef: { current: null },
  isDraggingRef: { current: false },
  setActionBarRange: vi.fn(),
  setHiddenActionBarRange: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

it('makes Ctrl+A contain the last cue even when it ends after the video', () => {
  const params = createParams();
  renderHook(() => useTimelineKeyboardShortcuts(params));

  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    vi.advanceTimersByTime(500);
  });

  const expected = { start: 0, end: 216.159 };
  expect(params.setDragCurrentTime).toHaveBeenCalledWith(expected.end);
  expect(params.setActionBarRange).toHaveBeenCalledWith(expected);
  expect(params.setHiddenActionBarRange).toHaveBeenCalledWith(expected);
  expect(params.onSegmentSelect).not.toHaveBeenCalled();
});

it('keeps Ctrl+A available for an SRT-only timeline', () => {
  const params = createParams({ duration: 0 });
  renderHook(() => useTimelineKeyboardShortcuts(params));

  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'A',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    vi.advanceTimersByTime(500);
  });

  expect(params.setActionBarRange).toHaveBeenCalledWith({ start: 0, end: 216.159 });
});

