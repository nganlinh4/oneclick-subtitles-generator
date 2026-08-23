import { DEFAULT_TRANSCRIPTION_MODEL_ID } from '../../../config/geminiModels';
import { buildAutoGenerateOptions } from './autoGenerateOptions';

const storage = (values = {}) => ({
  getItem: (key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null,
});

test('builds a desktop full-media request from normalized saved choices', () => {
  const videoFile = { assetId: 'asset-1', type: 'video/mp4' };
  const result = buildAutoGenerateOptions({
    storage: storage({
      video_processing_fps: '1.5',
      video_processing_media_resolution: 'medium',
      video_processing_max_duration: '4',
      segment_processing_delay: '3',
      video_processing_max_words: '9',
      show_favorite_max_length: 'false',
    }),
    videoFile,
    duration: 42.5,
  });

  expect(result).toEqual(expect.objectContaining({
    segment: { start: 0, end: 42.5 },
    fps: 1.5,
    mediaResolution: 'medium',
    model: DEFAULT_TRANSCRIPTION_MODEL_ID,
    maxDurationPerRequest: 240,
    segmentProcessingDelay: 3,
    autoSplitSubtitles: false,
    maxWordsPerSubtitle: 9,
    inlineExtraction: true,
    method: 'old',
    videoFile,
  }));
});

test('bounds corrupt storage and uses the Files API method in the hosted app', () => {
  const result = buildAutoGenerateOptions({
    storage: storage({
      video_processing_fps: '999',
      video_processing_media_resolution: 'hostile',
      video_processing_max_duration: '-4',
      segment_processing_delay: 'Infinity',
      video_processing_max_words: '0',
    }),
    videoFile: { name: 'clip.mp4' },
    duration: 1,
    isVercelMode: true,
  });

  expect(result).toEqual(expect.objectContaining({
    fps: 5,
    mediaResolution: 'low',
    maxDurationPerRequest: 60,
    segmentProcessingDelay: 0,
    maxWordsPerSubtitle: 1,
    inlineExtraction: false,
    method: 'new',
  }));
});

test('carries timing-generation subtitles and the active prompt/rules snapshot', () => {
  const context = { runId: 'run-1' };
  const result = buildAutoGenerateOptions({
    storage: storage({
      video_processing_prompt_preset: 'describe-video',
      video_processing_use_transcription_rules: 'true',
      transcription_prompt: 'My {contentType} prompt',
      user_prompt_presets: JSON.stringify([{ id: 'custom-1', prompt: 'Custom' }]),
    }),
    videoFile: { assetId: 'asset-1', type: 'video/mp4' },
    duration: 60,
    transcriptionRules: { atmosphere: 'studio' },
    userProvidedSubtitles: 'First line\nSecond line',
    autoRunContext: context,
  });

  expect(result).toEqual(expect.objectContaining({
    promptPreset: 'timing-generation',
    userProvidedSubtitles: 'First line\nSecond line',
    useUserProvidedSubtitles: true,
    useTranscriptionRules: true,
    autoSplitSubtitles: false,
    generationScope: 'full-media',
    useOutsideResultsContext: false,
    outsideContextText: '',
    autoRunContext: context,
  }));
  expect(result.promptContext).toEqual(expect.objectContaining({
    presetId: 'timing-generation',
    transcriptionRules: { atmosphere: 'studio' },
    useOutsideResultsContext: false,
  }));
});

test('uses only the project-owned subtitle text, regardless of a stale browser flag', () => {
  const common = {
    videoFile: { assetId: 'asset-1', type: 'video/mp4' },
    duration: 12,
  };
  const withProjectText = buildAutoGenerateOptions({
    ...common,
    storage: storage({ use_user_provided_subtitles: 'false' }),
    userProvidedSubtitles: 'Durable project line',
  });
  const withoutProjectText = buildAutoGenerateOptions({
    ...common,
    storage: storage({ use_user_provided_subtitles: 'true' }),
    userProvidedSubtitles: '',
  });

  expect(withProjectText).toMatchObject({
    useUserProvidedSubtitles: true,
    userProvidedSubtitles: 'Durable project line',
    promptPreset: 'timing-generation',
  });
  expect(withoutProjectText).toMatchObject({
    useUserProvidedSubtitles: false,
    userProvidedSubtitles: undefined,
  });
});

test('forces hosted audio into one Gemini request and clears stale outside context', () => {
  const result = buildAutoGenerateOptions({
    storage: storage({
      video_processing_max_duration: '1',
      video_processing_use_outside_context: 'true',
      video_processing_outside_context_text: 'stale neighbouring subtitles',
    }),
    videoFile: { assetId: 'asset-1', type: 'audio/mpeg' },
    duration: 3_600,
    isVercelMode: true,
  });

  expect(result.method).toBe('new');
  expect(result.inlineExtraction).toBe(false);
  expect(result.maxDurationPerRequest).toBe(999_999_999);
  expect(result.promptContext.useOutsideResultsContext).toBe(false);
  expect(result.promptContext.outsideContextText).toBe('');
});

test.each([
  [{ duration: 0, videoFile: { name: 'clip.mp4' } }, 'duration'],
  [{ duration: 2, videoFile: null }, 'prepared media'],
])('fails closed when a required automatic-processing input is absent', (overrides, message) => {
  expect(() => buildAutoGenerateOptions({ storage: storage(), ...overrides }))
    .toThrow(message);
});
