import runVideoProcess from './runVideoProcess';
import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';

vi.mock('../platform/mediaService', async (importOriginal) => ({
  ...(await importOriginal()),
  isNativeMediaDescriptor: vi.fn((value) => value?.__nativeMedia === true),
}));
vi.mock('../platform/mediaPipelineService', () => ({
  inspectMediaPipelineAsset: vi.fn(),
}));
vi.mock('../utils/toastUtils', () => ({ showInfoToast: vi.fn() }));

it('uses native inspection for audio duration without creating a blob URL', async () => {
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

  expect(inspectMediaPipelineAsset).toHaveBeenCalledWith(videoFile.assetId);
  expect(createObjectUrl).not.toHaveBeenCalled();
  expect(onSelectedSegmentChange).toHaveBeenCalledWith({ start: 0, end: 11.141905 });
  expect(onProcess).toHaveBeenCalledWith(expect.objectContaining({
    segment: { start: 0, end: 11.141905 },
    videoFile,
  }));
  createObjectUrl.mockRestore();
});
