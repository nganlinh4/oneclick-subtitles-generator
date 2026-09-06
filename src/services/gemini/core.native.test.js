import { callGeminiApi, streamGeminiApiWithFilesApi } from './core';
import { runNativeGeminiTranscription } from '../../platform/nativeGeminiTranscription';
import {
  inspectMediaPipelineAsset,
  runMediaPipeline,
} from '../../platform/mediaPipelineService';
import { getEmptySpeechPolicy, getTranscriptionPrompt } from './promptManagement';
import { createRequestController } from './requestManagement';
import { ensureNativeMediaToolsReady } from '../../platform/nativeDownloadPreflight';

const ownership = vi.hoisted(() => ({
  assertCurrent: vi.fn((context) => context),
  assertDurable: vi.fn(async (context) => context),
}));

vi.mock('../../platform/mediaService', () => ({ isNativeMediaDescriptor: () => true }));
vi.mock('../../platform/nativeGeminiMediaAnalysis', () => ({
  runNativeGeminiMediaAnalysis: vi.fn(),
}));
vi.mock('../../platform/nativeGeminiTranscription', () => ({
  runNativeGeminiTranscription: vi.fn(),
}));
vi.mock('../../platform/mediaPipelineService', () => ({
  inspectMediaPipelineAsset: vi.fn(),
  runMediaPipeline: vi.fn(),
}));
vi.mock('../../platform/nativeDownloadPreflight', () => ({
  ensureNativeMediaToolsReady: vi.fn(),
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
  getEmptySpeechPolicy: vi.fn(() => 'provenSilence'),
  getTranscriptionPrompt: vi.fn(() => 'Transcribe the selected media.'),
}));
vi.mock('../../utils/autoGenerationOwnership', () => ({
  isAutoGenerationContext: vi.fn((value) => value?.kind === 'auto-generation-context'),
  assertAutoGenerationContextCurrent: ownership.assertCurrent,
  assertAutoGenerationContextDurable: ownership.assertDurable,
}));

beforeEach(() => {
  vi.clearAllMocks();
  createRequestController.mockReturnValue({
    requestId: 'native-request',
    signal: new AbortController().signal,
  });
  getTranscriptionPrompt.mockReturnValue('Transcribe the selected media.');
  getEmptySpeechPolicy.mockReturnValue('provenSilence');
  ownership.assertCurrent.mockImplementation((context) => context);
  ownership.assertDurable.mockImplementation(async (context) => context);
  runNativeGeminiTranscription.mockResolvedValue({
    text: JSON.stringify([{
      startTime: '00m00s000ms',
      endTime: '00m01s000ms',
      text: 'Hello',
    }]),
    usage: null,
    job: { id: 'job-native' },
    deliveryId: 'delivery-native',
    acknowledge: vi.fn(),
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
  inspectMediaPipelineAsset.mockResolvedValue({ durationUs: 60_000_000 });
  ensureNativeMediaToolsReady.mockResolvedValue({ ready: true });
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
    prompt: expect.stringContaining('all timestamps are relative to the supplied media'),
    emptySpeechPolicy: 'provenSilence',
    thinkingLevel: 'minimal',
    mediaResolution: 'medium',
  }));
  expect(getTranscriptionPrompt).toHaveBeenCalledWith('video', undefined, {
    segmentInfo: {},
  });
  expect(subtitles).toHaveLength(1);
  expect(subtitles[0]).toMatchObject({ text: 'Hello' });
});

it('forwards cumulative native stream text and does not synthesize a final chunk', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });
  const first = '[{"startTime":"00m00s000ms","endTime":"00m01s000ms","text":"One"}';
  const second = ',{"startTime":"00m01s000ms","endTime":"00m02s000ms","text":"Two"}]';
  runNativeGeminiTranscription.mockImplementationOnce(async ({ onChunk }) => {
    onChunk(first);
    onChunk(second);
    return {
      text: `${first}${second}`,
      usage: null,
      job: { id: 'job-stream' },
      deliveryId: 'delivery-stream',
      acknowledge: vi.fn(),
    };
  });
  const onChunk = vi.fn();
  const onComplete = vi.fn();

  await expect(streamGeminiApiWithFilesApi(
    media,
    { modelId: 'gemini-3.5-flash-lite' },
    onChunk,
    onComplete,
  )).resolves.toHaveLength(2);

  expect(onChunk).toHaveBeenNthCalledWith(1, { accumulatedText: first });
  expect(onChunk).toHaveBeenNthCalledWith(2, { accumulatedText: `${first}${second}` });
  expect(onChunk).toHaveBeenCalledTimes(2);
  expect(onComplete).toHaveBeenCalledWith([
    expect.objectContaining({ text: 'One' }),
    expect.objectContaining({ text: 'Two' }),
  ]);
});

it('does not enable speech-only handling for custom or descriptive intent', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });
  getEmptySpeechPolicy.mockReturnValue(undefined);

  await expect(callGeminiApi(media, 'video')).resolves.toHaveLength(1);

  expect(runNativeGeminiTranscription).toHaveBeenCalledWith(
    expect.not.objectContaining({ emptySpeechPolicy: expect.anything() })
  );
});

it('extracts only the requested audio range and uploads no source video in audio-only mode', async () => {
  runMediaPipeline.mockResolvedValueOnce({ media: { asset: { id: 'audio-derived', kind: 'audio' } } });
  await callGeminiApi({ assetId: 'source-video', type: 'video/mp4' }, 'file-upload', {
    audioOnly: true,
    segmentInfo: { start: 20, end: 40 },
    mediaResolution: 'medium',
  });
  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'extractAudio', assetId: 'source-video', format: 'flac', range: { start: 20, end: 40 },
  }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(runNativeGeminiTranscription).toHaveBeenCalledWith(expect.objectContaining({
    assetId: 'audio-derived', mediaResolution: undefined,
  }));
  expect(getTranscriptionPrompt).toHaveBeenCalledWith('audio', undefined, expect.any(Object));
});

it('never falls back to uploading video when audio extraction fails', async () => {
  runMediaPipeline.mockRejectedValueOnce(Object.assign(new Error('generic transport message'), { code: 'mediaMissingAudio' }));
  await expect(callGeminiApi({ assetId: 'silent-video', type: 'video/mp4' }, 'file-upload', {
    audioOnly: true,
  })).rejects.toThrow('This media has no audio track to transcribe.');
  expect(runNativeGeminiTranscription).not.toHaveBeenCalled();
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
  expect(ensureNativeMediaToolsReady).toHaveBeenCalledWith({
    signal: expect.any(AbortSignal),
  });
  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'analysisClip',
    assetId: media.assetId,
    range: { start: 10, end: 20 },
  }, expect.objectContaining({ signal: expect.any(Object) }));
  expect(runNativeGeminiTranscription).toHaveBeenCalledWith(expect.objectContaining({
    assetId: '0198a8d7-dbf8-7ee0-a949-f13427fdd78a',
    prompt: expect.stringContaining('all timestamps are relative to the supplied media'),
  }));
  expect(runNativeGeminiTranscription.mock.calls[0][0].signal).toBe(
    runMediaPipeline.mock.calls[0][1].signal
  );
  expect(runNativeGeminiTranscription).not.toHaveBeenCalledWith(expect.objectContaining({
    assetId: media.assetId,
  }));
});

it('sends a whole-source segment directly without a redundant media re-encode', async () => {
  let toolsReady = false;
  ensureNativeMediaToolsReady.mockImplementation(async () => { toolsReady = true; });
  inspectMediaPipelineAsset.mockImplementation(async () => {
    if (!toolsReady) throw new Error('mediaToolsUnavailable');
    return { durationUs: 60_000_000 };
  });
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });

  await expect(callGeminiApi(media, 'video', {
    segmentInfo: { start: 0, end: 60, duration: 60 },
  })).resolves.toHaveLength(1);

  expect(inspectMediaPipelineAsset).toHaveBeenCalledWith(media.assetId);
  expect(ensureNativeMediaToolsReady).toHaveBeenCalledBefore(inspectMediaPipelineAsset);
  expect(runMediaPipeline).not.toHaveBeenCalled();
  expect(runNativeGeminiTranscription).toHaveBeenCalledWith(expect.objectContaining({
    assetId: media.assetId,
  }));
});

it('does not treat a near-full segment with a meaningful leading trim as whole-source', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });

  await callGeminiApi(media, 'video', {
    segmentInfo: { start: 0.5, end: 60, duration: 59.5 },
  });

  expect(inspectMediaPipelineAsset).not.toHaveBeenCalled();
  expect(runMediaPipeline).toHaveBeenCalledWith(expect.objectContaining({
    operation: 'analysisClip',
    range: { start: 0.5, end: 60 },
  }), expect.any(Object));
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

it('refuses to silently ignore an oversized unsplit native range', async () => {
  const media = Object.freeze({
    assetId: '01890f39-7b62-7c4e-8c9a-000000000101',
    name: 'clip.mp4',
    type: 'video/mp4',
  });

  await expect(callGeminiApi(media, 'video', {
    segmentInfo: { start: 0, end: 240, duration: 240 },
    maxDurationPerRequest: 60,
  })).rejects.toThrow('received an unsplit range');
  expect(runMediaPipeline).not.toHaveBeenCalled();
  expect(runNativeGeminiTranscription).not.toHaveBeenCalled();
});

it('revalidates the captured project immediately before native Gemini registration', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });
  const context = {
    kind: 'auto-generation-context',
    runId: 'run-1',
    media,
    cacheId: 'cache-1',
    projectId: 'project-1',
    assetId: media.assetId,
    signal: new AbortController().signal,
  };
  ownership.assertDurable
    .mockResolvedValueOnce(context)
    .mockRejectedValueOnce(new Error('project switched'));

  await expect(callGeminiApi(media, 'video', { autoRunContext: context }))
    .rejects.toThrow('project switched');
  expect(runNativeGeminiTranscription).not.toHaveBeenCalled();
});

it('revalidates ownership after native Gemini before returning any result', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });
  const context = {
    kind: 'auto-generation-context',
    runId: 'run-1',
    media,
    cacheId: 'cache-1',
    projectId: 'project-1',
    assetId: media.assetId,
    signal: new AbortController().signal,
  };
  ownership.assertDurable
    .mockResolvedValueOnce(context)
    .mockResolvedValueOnce(context)
    .mockRejectedValueOnce(new Error('project switched'));

  await expect(callGeminiApi(media, 'video', { autoRunContext: context }))
    .rejects.toThrow('project switched');
  expect(runNativeGeminiTranscription).toHaveBeenCalledTimes(1);
});

it('forwards exact native project admission and retains delivery ownership beside parsed rows', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });
  const acknowledge = vi.fn();
  runNativeGeminiTranscription.mockResolvedValueOnce({
    text: JSON.stringify([{
      startTime: '00m00s000ms',
      endTime: '00m01s000ms',
      text: 'Hello',
    }]),
    usage: null,
    job: { id: 'job-project' },
    deliveryId: 'delivery-project',
    acknowledge,
  });

  const subtitles = await callGeminiApi(media, 'video', {
    projectId: '0198a8d7-dbf9-7ee0-a949-f13427fdd78a',
    expectedProjectStateVersion: 14,
  });

  expect(runNativeGeminiTranscription).toHaveBeenCalledWith(expect.objectContaining({
    projectId: '0198a8d7-dbf9-7ee0-a949-f13427fdd78a',
    expectedProjectStateVersion: 14,
  }));
  const { getGeminiTranscriptionDeliveries } = await import('./transcriptionDelivery');
  expect(getGeminiTranscriptionDeliveries(subtitles)).toEqual([{
    jobId: 'job-project',
    deliveryId: 'delivery-project',
    acknowledge,
  }]);
  expect(acknowledge).not.toHaveBeenCalled();
});

it('leaves a malformed provider result pending instead of acknowledging an unparsed payload', async () => {
  const media = Object.freeze({
    assetId: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a',
    name: 'clip.mp4',
    type: 'video/mp4',
  });
  const acknowledge = vi.fn();
  runNativeGeminiTranscription.mockResolvedValueOnce({
    text: '{"not":"subtitles"}',
    usage: null,
    job: { id: 'job-invalid' },
    deliveryId: 'delivery-invalid',
    acknowledge,
  });

  await expect(callGeminiApi(media, 'video')).rejects.toThrow();
  expect(acknowledge).not.toHaveBeenCalled();
});
