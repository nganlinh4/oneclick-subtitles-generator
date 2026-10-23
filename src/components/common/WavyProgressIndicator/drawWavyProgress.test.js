import { drawWavyProgress } from './drawWavyProgress';

const recordingContext = () => {
  const calls = [];
  const ctx = new Proxy({ calls }, {
    get: (target, key) => {
      if (key in target) return target[key];
      return (...args) => { calls.push([key, ...args]); };
    },
    set: (target, key, value) => {
      calls.push([`=${String(key)}`, value]);
      target[key] = value;
      return true;
    },
  });
  return ctx;
};

const frame = (overrides = {}) => ({
  width: 104,
  totalHeight: 20,
  effectiveHeight: 20,
  progress: 0.5,
  heightFactor: 1,
  amplitude: 0,
  waveOffset: 0,
  wavelength: 20,
  strokeWidth: 4,
  gapSize: 4,
  stopSize: 4,
  showStopIndicator: true,
  colors: { indicator: 'red', track: 'grey', stop: 'blue' },
  shadow: { enabled: false, color: 'black', blur: 2, offsetX: 0, offsetY: 1 },
  ...overrides,
});

const ops = (ctx, name) => ctx.calls.filter(([key]) => key === name).map(([, ...args]) => args);

test('a hidden frame only clears the canvas', () => {
  const ctx = recordingContext();
  drawWavyProgress(ctx, frame({ heightFactor: 0 }));
  expect(ctx.calls).toEqual([['clearRect', 0, 0, 104, 20]]);
});

test('a flat half-progress frame draws the receding track, the progress line and the stop dot', () => {
  const ctx = recordingContext();
  drawWavyProgress(ctx, frame());
  // progress front x = 2 + 0.5 * 100 = 52; track starts after the gap and the cap.
  expect(ops(ctx, 'moveTo')).toEqual([[58, 0], [2, 0]]);
  expect(ops(ctx, 'lineTo')).toEqual([[102, 0], [52, 0]]);
  expect(ops(ctx, 'stroke')).toHaveLength(2);
  expect(ops(ctx, 'arc')).toEqual([[102, 10, 2, 0, 2 * Math.PI]]);
  expect(ctx.fillStyle).toBe('blue');
  expect(ops(ctx, 'scale')).toEqual([[1, 1]]);
});

test('zero progress draws the full track and no progress stroke', () => {
  const ctx = recordingContext();
  drawWavyProgress(ctx, frame({ progress: 0, showStopIndicator: false }));
  expect(ops(ctx, 'moveTo')).toEqual([[2, 0]]);
  expect(ops(ctx, 'lineTo')).toEqual([[102, 0]]);
  expect(ops(ctx, 'arc')).toEqual([]);
});

test('an animated amplitude traces a sampled wave and applies the progress shadow', () => {
  const ctx = recordingContext();
  drawWavyProgress(ctx, frame({
    progress: 1,
    amplitude: 1,
    shadow: { enabled: true, color: 'black', blur: 2, offsetX: 0, offsetY: 1 },
  }));
  // Full progress: 100px / 2 = 50 steps -> 51 points; the track is skipped and no stop dot.
  expect(ops(ctx, 'moveTo')).toHaveLength(1);
  expect(ops(ctx, 'lineTo')).toHaveLength(50);
  expect(ops(ctx, 'arc')).toEqual([]);
  expect(ctx.calls).toContainEqual(['=shadowColor', 'black']);
  expect(ctx.shadowColor).toBe('transparent');
});
