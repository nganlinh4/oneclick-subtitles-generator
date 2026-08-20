import { createNativeGeminiMediaAnalysis } from './nativeGeminiMediaAnalysis';

vi.mock('./nativeGeminiJobLifecycle', () => ({
  createNativeGeminiJobRunner: vi.fn(() => ({ run: vi.fn() })),
}));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';

test('uses an opaque media asset with the structured analysis task', async () => {
  const run = vi.fn().mockResolvedValue({ text: '{"recommendedPreset":{}}' });
  const service = createNativeGeminiMediaAnalysis({ runner: { run } });
  const request = {
    assetId: ASSET_ID,
    model: 'gemini-3.5-flash-lite',
    prompt: 'Analyze this video',
    responseJsonSchema: { type: 'object' },
    thinkingLevel: 'minimal',
    mediaResolution: 'low',
  };

  await expect(service.run(request)).resolves.toEqual({ text: '{"recommendedPreset":{}}' });
  expect(run).toHaveBeenCalledWith({
    request: {
      task: 'analyzeSubtitles',
      model: 'gemini-3.5-flash-lite',
      prompt: 'Analyze this video',
      mediaAssetId: ASSET_ID,
      responseJsonSchema: { type: 'object' },
      maxOutputTokens: undefined,
      thinkingLevel: 'minimal',
      mediaResolution: 'low',
    },
    signal: undefined,
    onChunk: undefined,
    onStarted: undefined,
  });
});
