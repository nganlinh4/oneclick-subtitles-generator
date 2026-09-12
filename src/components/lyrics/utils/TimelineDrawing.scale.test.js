import { drawTimeline } from './TimelineDrawing';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('does not reallocate the canvas every draw at fractional Windows display scaling', () => {
  vi.stubGlobal('devicePixelRatio', 1.25);
  const context = new Proxy({}, { get(target, key) {
    if (!(key in target)) target[key] = vi.fn();
    return target[key];
  } });
  const canvas = document.createElement('canvas');
  document.createElement('div').append(canvas);
  Object.defineProperties(canvas, { clientWidth: { value: 101 }, clientHeight: { value: 50 } });
  vi.spyOn(canvas, 'getContext').mockReturnValue(context);
  const widthWrites = vi.spyOn(canvas, 'width', 'set');
  const heightWrites = vi.spyOn(canvas, 'height', 'set');
  for (let index = 0; index < 10; index++) {
    drawTimeline(canvas, 60, [], index, { start: 0, end: 60 }, 0, false, 'seconds');
  }
  expect(widthWrites).toHaveBeenCalledTimes(1);
  expect(heightWrites).toHaveBeenCalledTimes(1);
  expect(canvas.width).toBe(126);
  expect(canvas.height).toBe(63);
  expect(context.setTransform).toHaveBeenLastCalledWith(1.25, 0, 0, 1.25, 0, 0);
});
