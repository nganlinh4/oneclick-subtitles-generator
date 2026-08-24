import { renderWaveform } from './waveformRendering';

const makeCanvas = () => {
  const calls = { lineTo: [], moveTo: [] };
  const gradient = { addColorStop: vi.fn() };
  const ctx = {
    scale: vi.fn(),
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    beginPath: vi.fn(),
    moveTo: vi.fn((...args) => calls.moveTo.push(args)),
    lineTo: vi.fn((...args) => calls.lineTo.push(args)),
    closePath: vi.fn(),
    fill: vi.fn(),
  };
  const canvas = {
    style: {},
    getContext: vi.fn(() => ctx),
  };
  return { canvas, ctx, calls };
};

const waveform = {
  durationSeconds: 10,
  peakRootMeanSquare: 1,
  levels: [{
    pointsPerSecond: 1,
    points: Array.from({ length: 10 }, () => ({ rootMeanSquare: 1 })),
  }],
};

const draw = (visibleTimeRange, containerWidth = 400, seekableEnd = 10) => {
  const harness = makeCanvas();
  renderWaveform(harness.canvas, containerWidth, {
    waveform,
    visibleTimeRange,
    seekableEnd,
    height: 30,
    dbgWave: vi.fn(),
  });
  return harness;
};

it('leaves the timeline gutter empty instead of stretching samples into it', () => {
  const { calls } = draw({ start: 0, end: 10.5 }, 105);

  expect(calls.moveTo[0]).toEqual([0, 30]);
  expect(calls.lineTo.at(-1)).toEqual([100, 30]);
  expect(Math.max(...calls.lineTo.map(([x]) => x))).toBe(100);
});

it('preserves waveform timestamps when a tail view extends past media', () => {
  const { calls } = draw({ start: 8, end: 12 }, 400);

  expect(calls.moveTo[0]).toEqual([0, 30]);
  expect(calls.lineTo.at(-1)).toEqual([200, 30]);
  expect(calls.lineTo.slice(0, -1).map(([x]) => x)).toEqual([50, 150]);
});

it('clips longer audio to the video seekable boundary', () => {
  const { calls } = draw({ start: 0, end: 10 }, 100, 9);

  expect(calls.lineTo.at(-1)).toEqual([90, 30]);
  expect(Math.max(...calls.lineTo.map(([x]) => x))).toBe(90);
});

