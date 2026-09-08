import runVideoProcess from './runVideoProcess';
import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';
import { getEngineDescriptor } from '../services/engines/transcriptionEngineRegistry';

it.each(['gemini-transcribe', 'gemini-transcribe-live'])('dispatches %s without inheriting video/prompt options or expanding the range', async (method) => {
  let request;
  const selectedSegment = { start: 15, end: 145 };
  await runVideoProcess({
    method, selectedSegment, videoFile: { type: 'audio/wav' },
    selectedModel: 'ordinary-model', selectedPromptPreset: 'describe-video',
    fps: 4, maxDurationPerRequest: 10, inlineExtraction: true,
    transcribeOptions: { windowDurationSecs: 30, languageHints: ['ko'], diarization: true },
    onProcess: (options) => { request = options; },
  });
  expect(request).toEqual({
    method, engine: 'gemini-3.5-transcribe', model: 'gemini-3.5-transcribe',
    ...(method === 'gemini-transcribe-live' ? { livePreview: true } : {}),
    segment: selectedSegment, videoFile: { type: 'audio/wav' }, audioOnly: true,
    inlineExtraction: false, windowDurationSecs: 30, languageHints: ['ko'],
    diarization: true, bypassCache: true,
  });
  expect(getEngineDescriptor(request.method).optionsPanel).toBe('transcribe');
  expect(getEngineDescriptor(request.method).capabilities.tokenCounting).toBe(false);
});

vi.mock('../platform/mediaService', async (importOriginal) => ({
  ...(await importOriginal()),
  isNativeMediaDescriptor: vi.fn((value) => value?.__nativeMedia === true),
}));
vi.mock('../platform/mediaPipelineService', () => ({
  inspectMediaPipelineAsset: vi.fn(),
}));
vi.mock('../utils/toastUtils', () => ({ showInfoToast: vi.fn() }));

it('preserves the selected native audio range and request limit without creating a blob URL', async () => {
  const videoFile = Object.freeze({
    __nativeMedia: true,
    assetId: '019ffbce-1d1a-7341-b053-f70b9af1b4f1',
    name: 'fresh.wav',
    type: 'audio/wav',
  });
  const onProcess = vi.fn();
  const onSelectedSegmentChange = vi.fn();
  const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
  inspectMediaPipelineAsset.mockResolvedValueOnce({ durationUs: 11_141_905 });

  await runVideoProcess({
    selectedSegment: { start: 2, end: 4 },
    isUploading: false,
    videoFile,
    inlineExtraction: false,
    isVercelMode: false,
    retryLock: false,
    onSelectedSegmentChange,
    useOutsideResultsContext: false,
    outsideContext: '',
    fps: 0.25,
    mediaResolution: 'low',
    selectedModel: 'gemini-3.5-flash-lite-preview',
    displayTokens: 100,
    realTokenCount: 100,
    selectedPromptPreset: 'general',
    customLanguage: '',
    useTranscriptionRules: false,
    method: 'new',
    asrMaxDurationPerRequest: 10,
    maxDurationPerRequest: 10,
    segmentProcessingDelay: 0,
    autoSplitSubtitles: true,
    maxWordsPerSubtitle: 12,
    asrStrategy: 'sentence',
    asrMaxChars: 80,
    asrMaxWords: 12,
    asrPreserveSentences: true,
    asrLanguage: '',
    t: (_key, fallback) => fallback,
    onProcess,
  });

  expect(inspectMediaPipelineAsset).not.toHaveBeenCalled();
  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(onSelectedSegmentChange).not.toHaveBeenCalled();
  expect(onProcess).toHaveBeenCalledWith(expect.objectContaining({
    segment: { start: 2, end: 4 },
    maxDurationPerRequest: 600,
    videoFile,
  }));
  createObjectUrl.mockRestore();
});
