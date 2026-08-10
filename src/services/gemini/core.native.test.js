import { callGeminiApi } from './core';
import { runNativeGeminiTranscription } from '../../platform/nativeGeminiTranscription';
import { runMediaPipeline } from '../../platform/mediaPipelineService';
import { getTranscriptionPrompt } from './promptManagement';
import { createRequestController } from './requestManagement';

vi.mock('../../platform/mediaService', () => ({ isNativeMediaDescriptor: () => true }));
vi.mock('../../platform/nativeGeminiMediaAnalysis', () => ({
  runNativeGeminiMediaAnalysis: vi.fn(),
}));
vi.mock('../../platform/nativeGeminiTranscription', () => ({
  runNativeGeminiTranscription: vi.fn(),
}));
vi.mock('../../platform/mediaPipelineService', () => ({
  runMediaPipeline: vi.fn(),
}));
vi.mock('./requestManagement', () => ({
  createRequestController: vi.fn(() => ({
    requestId: 'native-request',
    signal: new AbortController().signal,
  })),
  removeRequestController: vi.fn(),
}));
vi.mock('../../utils/thinkingBudgetUtils', () => ({
  addThinkingConfig: (request) => request,
  getThinkingBudget: () => 'minimal',
}));
vi.mock('./promptManagement', () => ({
  getTranscriptionPrompt: vi.fn(() => 'Transcribe the selected media.'),
}));

beforeEach(() => {
  vi.clearAllMocks();
  createRequestController.mockReturnValue({
    requestId: 'native-request',
    signal: new AbortController().signal,
  });
  getTranscriptionPrompt.mockReturnValue('Transcribe the selected media.');
  runNativeGeminiTranscription.mockResolvedValue({
    text: JSON.stringify([{
      startTime: '00m00s000ms',
      endTime: '00m01s000ms',
      text: 'Hello',
    }]),
    usage: null,
  });
  runMediaPipeline.mockResolvedValue({
    kind: 'media',
    media: {
      asset: {
        id: '0198a8d7-dbf8-7ee0-a949-f13427fdd78a',
        kind: 'video',
      },
    },
  });
});

it('routes native transcription through opaque media and credential services', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });

  const subtitles = await callGeminiApi(media, 'video', {
    modelId: 'gemini-3.5-flash-lite',
    mediaResolution: 'medium',
  });

  expect(runNativeGeminiTranscription).toHaveBeenCalledWith(expect.objectContaining({
    assetId: media.assetId,
    model: 'gemini-3.5-flash-lite',
    prompt: 'Transcribe the selected media.',
    thinkingLevel: 'minimal',
    mediaResolution: 'medium',
  }));
  expect(subtitles).toHaveLength(1);
  expect(subtitles[0]).toMatchObject({ text: 'Hello' });
});

it('clips a native segment first and sends only the derived asset to Gemini', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });

  await expect(callGeminiApi(media, 'video', {
    segmentInfo: { start: 10, end: 20, duration: 10 },
  })).resolves.toHaveLength(1);
  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'analysisClip',
    assetId: media.assetId,
    range: { start: 10, end: 20 },
  }, expect.objectContaining({ signal: expect.any(Object) }));
  expect(runNativeGeminiTranscription).toHaveBeenCalledWith(expect.objectContaining({
    assetId: '0198a8d7-dbf8-7ee0-a949-f13427fdd78a',
    prompt: 'Transcribe the selected media.',
  }));
  expect(runNativeGeminiTranscription.mock.calls[0][0].signal).toBe(
    runMediaPipeline.mock.calls[0][1].signal
  );
  expect(runNativeGeminiTranscription).not.toHaveBeenCalledWith(expect.objectContaining({
    assetId: media.assetId,
  }));
});

it('rejects an invalid native segment before starting either native job', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });

  await expect(callGeminiApi(media, 'video', {
    segmentInfo: { start: 20, end: 10 },
  })).rejects.toThrow('segment range is invalid');
  expect(runMediaPipeline).not.toHaveBeenCalled();
  expect(runNativeGeminiTranscription).not.toHaveBeenCalled();
});
