import { act, renderHook } from '@testing-library/react';
import { useTimelinePointerInteraction } from './useTimelinePointerInteraction';

// One pixel is one second: a 100px canvas showing 0-100s of 100s media.
const makeCanvas = () => {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 });
  return canvas;
};

const makeParams = (overrides = {}) => ({
  timelineRef: { current: makeCanvas() },
  duration: 100,
  lyrics: [{ start: 50, end: 55, text: 'cue' }],
  getTimeRange: () => ({ start: 0, end: 100 }),
  onTimelineClick: vi.fn(),
  onSegmentSelect: vi.fn(),
  onClearRange: vi.fn(),
  selectedSegment: null,
  actionBarRange: null,
  hiddenActionBarRange: null,
  setActionBarRange: vi.fn(),
  setHiddenActionBarRange: vi.fn(),
  setMoveDragOffsetPx: vi.fn(),
  setIsDraggingSegment: vi.fn(),
  setDragStartTime: vi.fn(),
  setDragCurrentTime: vi.fn(),
  setHasDraggedInSession: vi.fn(),
  dragStartRef: { current: null },
  dragCurrentRef: { current: null },
  isDraggingRef: { current: false },
  isRangeMoveDraggingRef: { current: false },
  isClickingInsideRef: { current: false },
  lastManualPanTime: { current: 0 },
  ...overrides,
});

const pointerEvent = (clientX) => ({ clientX, clientY: 5, preventDefault: vi.fn(), stopPropagation: vi.fn() });

const mouseDrag = (result, fromX, toX) => {
  act(() => result.current.handleMouseDown(pointerEvent(fromX)));
  if (toX !== fromX) {
    act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: toX })));
  }
  act(() => document.dispatchEvent(new MouseEvent('mouseup', { clientX: toX })));
};

afterEach(() => {
  sessionStorage.clear();
});

test('a click seeks to the clicked time and clears a selection it falls outside', () => {
  const params = makeParams({ hiddenActionBarRange: { start: 60, end: 70 } });
  const { result } = renderHook(() => useTimelinePointerInteraction(params));

  mouseDrag(result, 40, 40);

  expect(params.onTimelineClick).toHaveBeenCalledExactlyOnceWith(40);
  expect(params.setActionBarRange).toHaveBeenLastCalledWith(null);
  expect(params.setHiddenActionBarRange).toHaveBeenLastCalledWith(null);
  expect(params.lastManualPanTime.current).toBeGreaterThan(0);
});

test('dragging over an empty range opens segment processing for that range', () => {
  const params = makeParams();
  const { result } = renderHook(() => useTimelinePointerInteraction(params));

  mouseDrag(result, 10, 40);

  expect(params.onSegmentSelect).toHaveBeenCalledExactlyOnceWith({ start: 10, end: 40 });
  expect(sessionStorage.getItem('processing_modal_open_reason')).toBe('drag-selection');
  expect(params.setHasDraggedInSession).toHaveBeenCalledWith(true);
  expect(params.onTimelineClick).not.toHaveBeenCalled();
  expect(params.isDraggingRef.current).toBe(false);
  expect(params.dragStartRef.current).toBeNull();
});

test('dragging over subtitles shows the range action bar instead of processing', () => {
  const params = makeParams();
  const { result } = renderHook(() => useTimelinePointerInteraction(params));

  mouseDrag(result, 45, 60);

  expect(params.onSegmentSelect).not.toHaveBeenCalled();
  expect(params.setActionBarRange).toHaveBeenLastCalledWith({ start: 45, end: 60 });
  expect(params.setHiddenActionBarRange).toHaveBeenLastCalledWith({ start: 45, end: 60 });
});

test('movement under the drag threshold is a click, not a selection', () => {
  const params = makeParams();
  const { result } = renderHook(() => useTimelinePointerInteraction(params));

  act(() => result.current.handleMouseDown(pointerEvent(10)));
  act(() => document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10.5 })));
  act(() => document.dispatchEvent(new MouseEvent('mouseup', { clientX: 10.5 })));

  expect(params.onSegmentSelect).not.toHaveBeenCalled();
  expect(params.onTimelineClick).toHaveBeenCalledTimes(1);
});

test('Delete clears the visible action-bar range unless typing in an editable field', () => {
  const params = makeParams({ actionBarRange: { start: 45, end: 60 } });
  renderHook(() => useTimelinePointerInteraction(params));
  const input = document.createElement('input');
  document.body.appendChild(input);

  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
  expect(params.onClearRange).not.toHaveBeenCalled();

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' })));
  expect(params.onClearRange).toHaveBeenCalledExactlyOnceWith(45, 60);
  expect(params.setActionBarRange).toHaveBeenLastCalledWith(null);
  input.remove();
});

test('the context menu opens processing only inside the selected segment', () => {
  const params = makeParams({ selectedSegment: { start: 20, end: 30 } });
  const { result } = renderHook(() => useTimelinePointerInteraction(params));

  act(() => result.current.handleContextMenu(pointerEvent(80)));
  expect(params.onSegmentSelect).not.toHaveBeenCalled();

  act(() => result.current.handleContextMenu(pointerEvent(25)));
  expect(params.onSegmentSelect).toHaveBeenCalledExactlyOnceWith({ start: 20, end: 30 });
  expect(sessionStorage.getItem('processing_modal_open_reason')).toBe('context-menu');
});

test('a selected segment beyond the media is clamped before it is used', () => {
  const params = makeParams({ selectedSegment: { start: 90, end: 150 } });
  const { result } = renderHook(() => useTimelinePointerInteraction(params));

  act(() => result.current.handleContextMenu(pointerEvent(95)));
  expect(params.onSegmentSelect).toHaveBeenCalledExactlyOnceWith({ start: 90, end: 100 });
});

test('a touch tap seeks directly to the tapped time', () => {
  const params = makeParams();
  const { result } = renderHook(() => useTimelinePointerInteraction(params));

  act(() => result.current.handleTouchStart({
    touches: [{ clientX: 33, clientY: 5 }],
    stopPropagation: vi.fn(),
  }));
  const end = new Event('touchend');
  end.changedTouches = [{ clientX: 33 }];
  act(() => document.dispatchEvent(end));

  expect(params.onTimelineClick).toHaveBeenCalledExactlyOnceWith(33);
});
