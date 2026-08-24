import { runMediaPipeline } from '../../platform/mediaPipelineService';
import {
  loadNativeWaveform,
  nativeWaveformDensity,
} from './audioProcessing';
import {
  prepareNativeWaveform,
  selectNativeWaveformLevel,
} from './waveformLOD';

vi.mock('../../platform/mediaPipelineService', () => ({ runMediaPipeline: vi.fn() }));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const waveform = {
  durationUs: 10_000_000,
  sourceSampleRateHz: 400,
  levels: [
    {
      pointsPerSecond: 4,
      points: [
        { minimum: -0.5, maximum: 0.5, rootMeanSquare: 0.25 },
        { minimum: -1, maximum: 1, rootMeanSquare: 1 },
      ],
    },
    {
      pointsPerSecond: 1,
      points: [{ minimum: -1, maximum: 1, rootMeanSquare: 0.5 }],
    },
  ],
};

beforeEach(() => {
  runMediaPipeline.mockReset();
});

it('keeps multi-hour and maximum-duration requests bounded', () => {
  expect(nativeWaveformDensity(10)).toEqual({ pointsPerSecond: 100, maxPoints: 1_000 });
  expect(nativeWaveformDensity(6 * 60 * 60)).toEqual({
    pointsPerSecond: 4,
    maxPoints: 86_400,
  });
  expect(nativeWaveformDensity(24 * 60 * 60)).toEqual({
    pointsPerSecond: 4,
    maxPoints: 250_000,
  });
  expect(nativeWaveformDensity(7 * 24 * 60 * 60)).toEqual({
    pointsPerSecond: 4,
    maxPoints: 604_800,
  });
});

it('runs one native operation, reports monotonic progress, and revalidates before publication', async () => {
  runMediaPipeline.mockImplementation(async (_request, options) => {
    options.onProgress({ fraction: 0.6, job: { progress: { basisPoints: 6_000 } } });
    options.onProgress({ fraction: 0.2, job: { progress: { basisPoints: 2_000 } } });
    return { kind: 'waveform', assetId: ASSET_ID, waveform };
  });
  const progress = vi.fn();
  const revalidate = vi.fn().mockResolvedValue(undefined);
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  await expect(loadNativeWaveform({
    assetId: ASSET_ID,
    durationSeconds: 10,
    signal: new AbortController().signal,
    onProgress: progress,
    revalidate,
  })).resolves.toBe(waveform);

  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'generateWaveform',
    assetId: ASSET_ID,
    pointsPerSecond: 100,
    maxPoints: 1_000,
    range: null,
  }, expect.objectContaining({ signal: expect.any(Object), onProgress: expect.any(Function) }));
  expect(progress.mock.calls.map(([value]) => value)).toEqual([0.6, 0.6, 1]);
  expect(revalidate).toHaveBeenCalledTimes(1);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('does not publish a completed native result when ownership refresh refuses it', async () => {
  runMediaPipeline.mockResolvedValue({ kind: 'waveform', assetId: ASSET_ID, waveform });
  const error = new Error('active media changed');
  error.name = 'ActiveNativeMediaError';

  await expect(loadNativeWaveform({
    assetId: ASSET_ID,
    durationSeconds: 10,
    signal: new AbortController().signal,
    revalidate: vi.fn().mockRejectedValue(error),
  })).rejects.toBe(error);
});

it('uses Rust pyramid levels directly instead of rebuilding them in JavaScript', () => {
  const prepared = prepareNativeWaveform(waveform);

  expect(prepared.levels).toBe(waveform.levels);
  expect(prepared.peakRootMeanSquare).toBe(1);
  expect(selectNativeWaveformLevel(prepared, 10, 10)).toBe(waveform.levels[0]);
  expect(selectNativeWaveformLevel(prepared, 10, 2)).toBe(waveform.levels[1]);
});
