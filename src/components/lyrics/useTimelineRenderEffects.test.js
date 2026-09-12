import { act, cleanup, renderHook } from '@testing-library/react';
import { useTimelineRenderEffects } from './useTimelineRenderEffects';

const ref = current => ({ current });
let observers, frames, nextId;
beforeEach(() => {
  vi.useFakeTimers();
  observers = []; frames = new Map(); nextId = 0;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  });
  vi.stubGlobal('requestAnimationFrame', callback => { const id = ++nextId; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const options = () => {
  const container = document.createElement('div');
  const canvas = document.createElement('canvas'); container.append(canvas);
  return {
    timelineRef: ref(canvas), animationFrameRef: ref(null), animationTimeRef: ref(0),
    newSegments: new Map(), setNewSegments: () => {}, newSegmentAnimationRef: ref(null),
    isProcessing: false, zoom: 1, currentZoomRef: ref(1), duration: 60,
    panOffset: 0, setPanOffset: () => {}, currentTime: 1, lyrics: [{ start: 0, end: 60 }],
    onSegmentSelect: () => {}, lastTimeRef: ref(0), lastManualPanTime: ref(0),
    disableAutoScroll: ref(true), getTimeRange: () => ({ start: 0, end: 60, total: 60 }),
    isScrollingRef: ref(false), debugCounter: ref(0), autoScrollRef: ref(null),
  };
};
const tick = () => act(() => {
  vi.advanceTimersByTime(34);
  const pending = [...frames.values()]; frames.clear();
  pending.forEach(callback => callback(performance.now()));
});

it('retains one observer across playback ticks and resize uses the latest draw', () => {
  const base = options(); let draw = vi.fn();
  const hook = renderHook(props => useTimelineRenderEffects(props), { initialProps: { ...base, renderTimeline: draw } });
  tick();
  for (let time = 2; time < 20; time++) {
    draw = vi.fn();
    hook.rerender({ ...base, currentTime: time, renderTimeline: draw });
  }
  expect(observers).toHaveLength(1);
  const before = draw.mock.calls.length;
  act(() => { observers[0].callback(); observers[0].callback(); });
  expect(frames.size).toBeLessThanOrEqual(1);
  tick();
  expect(draw.mock.calls.length).toBeGreaterThan(before);
  hook.unmount();
  expect(observers[0].disconnected).toBe(true);
  expect(frames.size).toBe(0);
});

it('keeps processing animation outside React state and cancels its single loop', () => {
  const base = options(); const draw = vi.fn();
  const hook = renderHook(props => useTimelineRenderEffects(props), {
    initialProps: { ...base, renderTimeline: draw, isProcessing: true },
  });
  tick(); const before = draw.mock.calls.length;
  tick(); tick();
  expect(draw.mock.calls.length).toBeGreaterThan(before);
  expect(base.animationTimeRef.current).toBeGreaterThanOrEqual(0);
  hook.rerender({ ...base, renderTimeline: draw, isProcessing: false });
  tick();
  expect(frames.size).toBe(0);
  hook.unmount();
});

it('caps processing canvas paints below a high-refresh animation clock', () => {
  const base = options(); const draw = vi.fn();
  const hook = renderHook(props => useTimelineRenderEffects(props), {
    initialProps: { ...base, renderTimeline: draw, isProcessing: true },
  });
  const initial = draw.mock.calls.length;
  for (let elapsed = 0; elapsed < 1000; elapsed += 10) {
    act(() => {
      vi.advanceTimersByTime(10);
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback(performance.now()));
    });
  }
  expect(draw.mock.calls.length - initial).toBeLessThanOrEqual(31);
  hook.unmount();
  expect(frames.size).toBe(0);
});
