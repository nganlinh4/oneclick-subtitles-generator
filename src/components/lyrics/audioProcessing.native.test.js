import { runMediaPipeline } from '../../platform/mediaPipelineService';
import {
  processAudioInSegments,
  processBlobInChunks,
  processEntireAudio,
  processNativeWaveform,
  waveformPyramidToLegacySamples,
} from './audioProcessing';

vi.mock('../../platform/mediaPipelineService', () => ({ runMediaPipeline: vi.fn() }));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;

const createContext = () => ({
  currentSource: PLAYBACK_URL,
  currentDuration: 10,
  duration: 10,
  audioContextRef: { current: null },
  processingSourceRef: { current: PLAYBACK_URL },
  audioDataCache: new Map(),
  dbgWave: vi.fn(),
  setWaveformLOD: vi.fn(),
  setIsProcessing: vi.fn(),
  setIsProcessed: vi.fn(),
  setHasAudio: vi.fn(),
  setAudioError: vi.fn(),
  setProcessingProgress: vi.fn(),
});

beforeEach(() => {
  runMediaPipeline.mockReset();
});

it('maps native RMS points through the same normalization curve as browser analysis', () => {
  const samples = waveformPyramidToLegacySamples({
    levels: [{
      points: [
        { rootMeanSquare: 0.25 },
        { rootMeanSquare: 1 },
        { rootMeanSquare: 0 },
      ],
    }],
  });

  expect(samples[0]).toBeCloseTo(Math.pow(0.25, 0.75), 5);
  expect(samples[1]).toBe(1);
  expect(samples[2]).toBeCloseTo(0.01, 5);
});

it('generates and caches a native waveform without fetching or decoding media in the WebView', async () => {
  runMediaPipeline.mockImplementation(async (_request, options) => {
    options.onProgress({
      fraction: 0.5,
      job: { progress: { basisPoints: 5000 } },
    });
    return {
      kind: 'waveform',
      assetId: ASSET_ID,
      waveform: {
        levels: [{
          points: [
            { rootMeanSquare: 0.5 },
            { rootMeanSquare: 1 },
          ],
        }],
      },
    };
  });
  const ctx = createContext();
  const fetchSpy = vi.spyOn(global, 'fetch');

  await processNativeWaveform(ctx, ASSET_ID, new AbortController().signal);

  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'generateWaveform',
    assetId: ASSET_ID,
    pointsPerSecond: 100,
    maxPoints: 1000,
    range: null,
  }, expect.objectContaining({ signal: expect.any(Object), onProgress: expect.any(Function) }));
  expect(ctx.setWaveformLOD).toHaveBeenCalledWith(expect.objectContaining({
    levels: expect.any(Array),
  }));
  expect(ctx.audioDataCache.get(ctx.currentSource)).toBe(
    ctx.setWaveformLOD.mock.calls[0][0]
  );
  expect(ctx.setProcessingProgress).toHaveBeenLastCalledWith(1);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('preserves the existing no-audio state for native missing-audio failures', async () => {
  const error = new Error('The native media operation could not be completed');
  error.code = 'mediaMissingAudio';
  runMediaPipeline.mockRejectedValue(error);
  const ctx = createContext();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await processNativeWaveform(ctx, ASSET_ID, new AbortController().signal);

  expect(ctx.setHasAudio).toHaveBeenCalledWith(false);
  expect(ctx.setAudioError).toHaveBeenCalledWith('No audio track found or it is corrupted.');
  expect(ctx.audioDataCache.get(ctx.currentSource)).toBe('NO_AUDIO');
  consoleError.mockRestore();
});

it.each([
  ['full decode', processEntireAudio],
  ['blob chunks', processBlobInChunks],
  ['range segments', processAudioInSegments],
])('fails closed before WebView fetch for native capability URLs (%s)', async (_name, process) => {
  const ctx = createContext();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  await process(ctx, new AbortController().signal);

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(ctx.setAudioError).toHaveBeenCalledWith(expect.stringContaining('Audio processing failed'));
  fetchSpy.mockRestore();
  consoleError.mockRestore();
});
