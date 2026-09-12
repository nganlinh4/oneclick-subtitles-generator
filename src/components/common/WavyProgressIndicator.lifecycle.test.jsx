import { act, cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import WavyProgressIndicator from './WavyProgressIndicator';

let frames, id, now, context;
beforeEach(() => {
  vi.useFakeTimers(); frames = new Map(); id = 0; now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', key => frames.delete(key));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  context = new Proxy({}, { get(target, key) { return target[key] ??= vi.fn(); } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const tick = () => act(() => {
  now += 16; vi.advanceTimersByTime(16);
  const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now));
});
it('does not keep drawing a flat paused seek bar', () => {
  render(<WavyProgressIndicator progress={0.5} animate={false} forceFlat waveSpeed={1} width={300} />);
  for (let i = 0; i < 100; i++) tick();
  const draws = context.clearRect.mock.calls.length;
  for (let i = 0; i < 30; i++) tick();
  expect(context.clearRect.mock.calls.length).toBe(draws);
  expect(frames.size).toBe(0);
});
it('animates a visible wave and cancels all owned work on unmount during a transition', () => {
  const bar = render(<WavyProgressIndicator progress={0.2} forceFlat={false} width={300} />);
  tick(); tick();
  expect(context.clearRect.mock.calls.length).toBeGreaterThan(0);
  bar.rerender(<WavyProgressIndicator progress={0.8} forceFlat={false} width={300} />);
  tick();
  bar.unmount();
  expect(frames.size).toBe(0);
});
it('survives strict remount and cancels resize work when an open surface closes', () => {
  const bar = render(<StrictMode><WavyProgressIndicator progress={0.5} /></StrictMode>);
  for (let i = 0; i < 5; i++) tick();
  expect(context.clearRect.mock.calls.length).toBeGreaterThan(1);
  act(() => window.dispatchEvent(new Event('resize')));
  bar.unmount();
  for (let i = 0; i < 15; i++) tick();
  expect(frames.size).toBe(0);
});
