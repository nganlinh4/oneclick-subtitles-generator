import { fireEvent, render, screen } from '@testing-library/react';

import TimelineRangeActionBar from './TimelineRangeActionBar';
import { createTimelineDomain } from './utils/timelineDomain';

vi.mock('./timelineOverlays', () => ({
  OverlayFollower: ({ children }) => children,
}));

const rows = [
  { id: 1, start: 3, end: 4, text: 'first' },
  { id: 2, start: 4.5, end: 5.5, text: 'second' },
];

const baseProps = (overrides = {}) => {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 1_000 });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 100, width: 1_000, height: 80 });
  return {
    actionBarRange: { start: 2.7, end: 6.3 },
    timelineRef: { current: canvas },
    getTimeRange: () => ({ start: 0, end: 19.9647 }),
    moveDragOffsetPx: 0,
    setMoveDragOffsetPx: vi.fn(),
    moveDragOffsetPxRef: { current: 0 },
    rangePreviewDeltaRef: { current: 0 },
    isRangeMoveDraggingRef: { current: false },
    isClickingInsideRef: { current: false },
    setActionBarRange: vi.fn(),
    setHiddenActionBarRange: vi.fn(),
    selectedSegment: null,
    timelineDomain: createTimelineDomain(rows, 19.014),
    onBeginMoveRange: vi.fn(),
    onPreviewMoveRange: vi.fn(),
    onCommitMoveRange: vi.fn(),
    onMoveRange: vi.fn(),
    onSegmentSelect: vi.fn(),
    onClearRange: vi.fn(),
    panOffset: 0,
    zoom: 1,
    lyrics: rows,
    t: (_key, fallback) => fallback,
    ...overrides,
  };
};

it('delivers one preview before one commit even when its props rerender during the drag', () => {
  const order = [];
  const props = baseProps({
    onBeginMoveRange: vi.fn(() => order.push('begin')),
    onPreviewMoveRange: vi.fn(() => order.push('preview')),
    onCommitMoveRange: vi.fn(() => order.push('commit')),
  });
  const { rerender } = render(<TimelineRangeActionBar {...props} />);
  const handle = screen.getByTitle('Drag to move subtitles in range');

  fireEvent.pointerDown(handle, { clientX: 100, pointerId: 7 });
  fireEvent.pointerMove(window, { clientX: 800, pointerId: 7 });
  rerender(<TimelineRangeActionBar {...props} lyrics={[...rows]} />);
  fireEvent.pointerUp(window, { clientX: 800, pointerId: 7 });

  expect(order).toEqual(['begin', 'preview', 'commit']);
  expect(props.rangePreviewDeltaRef.current).toBe(0);
  expect(props.moveDragOffsetPxRef.current).toBe(0);
  expect(props.setActionBarRange).toHaveBeenLastCalledWith(null);
  expect(props.setHiddenActionBarRange).toHaveBeenLastCalledWith(null);
});

it('clamps the preview delta at media duration before committing', () => {
  const props = baseProps();
  render(<TimelineRangeActionBar {...props} />);
  const handle = screen.getByTitle('Drag to move subtitles in range');

  fireEvent.pointerDown(handle, { clientX: 100, pointerId: 8 });
  fireEvent.pointerMove(window, { clientX: 2_000, pointerId: 8 });
  const expected = 19.014 - 6.3;
  expect(props.onPreviewMoveRange).toHaveBeenCalledWith(expect.closeTo(expected, 8));
  fireEvent.pointerUp(window, { clientX: 2_000, pointerId: 8 });

  expect(props.onCommitMoveRange).toHaveBeenCalledTimes(1);
});

it('supports a mouse-only desktop WebView without double-starting after pointerdown', () => {
  const order = [];
  const props = baseProps({
    onBeginMoveRange: vi.fn(() => order.push('begin')),
    onPreviewMoveRange: vi.fn(() => order.push('preview')),
    onCommitMoveRange: vi.fn(() => order.push('commit')),
  });
  const { unmount } = render(<TimelineRangeActionBar {...props} />);
  const handle = screen.getByTitle('Drag to move subtitles in range');

  fireEvent.mouseDown(handle, { clientX: 100 });
  fireEvent.mouseMove(window, { clientX: 800 });
  fireEvent.mouseUp(window, { clientX: 800 });
  expect(order).toEqual(['begin', 'preview', 'commit']);
  unmount();

  const duplicateProps = baseProps({
    onBeginMoveRange: vi.fn(() => order.push('begin-duplicate-check')),
    onCommitMoveRange: vi.fn(() => order.push('commit-duplicate-check')),
  });
  render(<TimelineRangeActionBar {...duplicateProps} />);
  const duplicateHandle = screen.getByTitle('Drag to move subtitles in range');
  fireEvent.pointerDown(duplicateHandle, { clientX: 100, pointerId: 9 });
  fireEvent.mouseDown(duplicateHandle, { clientX: 100 });
  fireEvent.pointerUp(window, { clientX: 100, pointerId: 9 });

  expect(duplicateProps.onBeginMoveRange).toHaveBeenCalledTimes(1);
  expect(duplicateProps.onCommitMoveRange).toHaveBeenCalledTimes(1);
});
