import { resolveActiveNativeMediaAssetId } from '../platform/activeNativeMedia';
import { runNativeGeminiMediaAnalysis } from '../platform/nativeGeminiMediaAnalysis';
import {
  inspectMediaPipelineAsset,
  runMediaPipeline,
} from '../platform/mediaPipelineService';
import { callGeminiApiWithFilesApiForAnalysis } from './gemini';
import { analyzeVideoWithGemini } from './videoAnalysisService';

vi.mock('../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../platform/activeNativeMedia', () => ({
  resolveActiveNativeMediaAssetId: vi.fn(),
}));
vi.mock('../platform/nativeGeminiMediaAnalysis', () => ({
  runNativeGeminiMediaAnalysis: vi.fn(),
}));
vi.mock('../platform/mediaPipelineService', () => ({
  inspectMediaPipelineAsset: vi.fn(),
  runMediaPipeline: vi.fn(),
}));
vi.mock('./gemini', () => ({
  callGeminiApiWithFilesApiForAnalysis: vi.fn(),
}));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const CLIP_ID = '01890f39-7b62-7c4e-8c9a-000000000102';
const analysis = {
  recommendedPreset: { id: 'general', reason: 'Mixed spoken content' },
  transcriptionRules: { terminology: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('gemini_api_key', 'must-never-be-read-by-native-analysis');
  resolveActiveNativeMediaAssetId.mockReturnValue(ASSET_ID);
  inspectMediaPipelineAsset.mockResolvedValue({ durationUs: 600_000_000 });
  runNativeGeminiMediaAnalysis.mockResolvedValue({ text: JSON.stringify(analysis) });
});

test('analyzes the opaque native media asset without browser Gemini transport or key access', async () => {
  const getItem = vi.spyOn(Storage.prototype, 'getItem');
  const onStatusUpdate = vi.fn();

  await expect(analyzeVideoWithGemini({ __nativeMedia: true }, onStatusUpdate))
    .resolves.toEqual(analysis);

  expect(inspectMediaPipelineAsset).toHaveBeenCalledWith(ASSET_ID);
  expect(runNativeGeminiMediaAnalysis).toHaveBeenCalledWith(expect.objectContaining({
    assetId: ASSET_ID,
    model: 'gemini-3.1-flash-lite',
    responseJsonSchema: expect.objectContaining({ type: 'object' }),
    thinkingLevel: 'minimal',
    mediaResolution: 'low',
    signal: expect.any(AbortSignal),
  }));
  expect(runMediaPipeline).not.toHaveBeenCalled();
  expect(callGeminiApiWithFilesApiForAnalysis).not.toHaveBeenCalled();
  expect(getItem).not.toHaveBeenCalledWith('gemini_api_key');
  getItem.mockRestore();
});

test('clips only the centered thirty-minute sample before native analysis', async () => {
  inspectMediaPipelineAsset.mockResolvedValue({ durationUs: 3_600_000_000 });
  runMediaPipeline.mockResolvedValue({ media: { asset: { id: CLIP_ID } } });

  await analyzeVideoWithGemini({ __nativeMedia: true }, vi.fn());

  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'analysisClip',
    assetId: ASSET_ID,
    range: { start: 900, end: 2700 },
  }, { signal: expect.any(AbortSignal) });
  expect(runNativeGeminiMediaAnalysis).toHaveBeenCalledWith(expect.objectContaining({
    assetId: CLIP_ID,
    prompt: expect.stringContaining('30-minute sample from the middle'),
  }));
});

test('fails closed when the value is not an authorized native media descriptor', async () => {
  resolveActiveNativeMediaAssetId.mockReturnValue(null);

  await expect(analyzeVideoWithGemini(new Blob(['video']), vi.fn()))
    .rejects.toMatchObject({ code: 'nativeMediaUnavailable' });
  expect(runNativeGeminiMediaAnalysis).not.toHaveBeenCalled();
  expect(callGeminiApiWithFilesApiForAnalysis).not.toHaveBeenCalled();
});
