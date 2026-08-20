import { analyzeVideoWithGemini } from '../../services/videoAnalysisService';
import { setTranscriptionRulesForCache } from '../transcriptionRulesStore';
import {
  assertAutoGenerationContextCurrent,
  assertAutoGenerationContextDurable,
} from '../autoGenerationOwnership';
import {
  analyzeVideoAndWaitForUserChoice,
  commitVideoAnalysisForContext,
} from './analysisUtils';

vi.mock('../../services/videoAnalysisService', () => ({ analyzeVideoWithGemini: vi.fn() }));
vi.mock('../../services/gemini/promptManagement', () => ({
  PROMPT_PRESETS: [{ id: 'general', prompt: 'General {contentType}' }],
}));
vi.mock('../transcriptionRulesStore', () => ({ setTranscriptionRulesForCache: vi.fn() }));
vi.mock('../autoGenerationOwnership', () => ({
  assertAutoGenerationContextCurrent: vi.fn((context) => context),
  assertAutoGenerationContextDurable: vi.fn(async (context) => context),
  isAutoGenerationContext: vi.fn(() => true),
}));

const context = Object.freeze({
  runId: 'run-1',
  cacheId: 'cache-1',
  projectId: 'project-1',
  sourceIdentity: 'asset:asset-1',
  signal: new AbortController().signal,
});
const analysisResult = {
  recommendedPreset: { id: 'general' },
  transcriptionRules: { terminology: ['Codex'] },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  analyzeVideoWithGemini.mockResolvedValue(analysisResult);
  setTranscriptionRulesForCache.mockResolvedValue(undefined);
});

test('analysis execution is side-effect-free until an explicit captured-project commit', async () => {
  const openListener = vi.fn();
  window.addEventListener('openRulesEditorWithCountdown', openListener);
  const signal = new AbortController().signal;

  await expect(analyzeVideoAndWaitForUserChoice(
    { assetId: 'asset-1' },
    vi.fn(),
    (_key, fallback) => fallback,
    { signal },
  )).resolves.toEqual({
    analysisResult,
    userChoice: {
      presetId: 'general',
      transcriptionRules: analysisResult.transcriptionRules,
    },
  });

  expect(analyzeVideoWithGemini).toHaveBeenCalledWith(
    { assetId: 'asset-1' },
    expect.any(Function),
    { signal },
  );
  expect(setTranscriptionRulesForCache).not.toHaveBeenCalled();
  expect(openListener).not.toHaveBeenCalled();
  expect(localStorage.getItem('video_processing_prompt_preset')).toBeNull();
  window.removeEventListener('openRulesEditorWithCountdown', openListener);
});

test('validates the captured project on both sides of native analysis', async () => {
  await analyzeVideoAndWaitForUserChoice(
    { assetId: 'asset-1' },
    vi.fn(),
    (_key, fallback) => fallback,
    { signal: context.signal, context },
  );

  expect(analyzeVideoWithGemini).toHaveBeenCalledWith(
    { assetId: 'asset-1' },
    expect.any(Function),
    { signal: context.signal, validateOwnership: expect.any(Function) },
  );
  await analyzeVideoWithGemini.mock.calls[0][2].validateOwnership();
  expect(assertAutoGenerationContextDurable).toHaveBeenCalledTimes(3);
});

test('awaits the exact project write before publishing the editor request', async () => {
  let releaseSave;
  setTranscriptionRulesForCache.mockReturnValue(new Promise((resolve) => { releaseSave = resolve; }));
  const openListener = vi.fn();
  window.addEventListener('openRulesEditorWithCountdown', openListener);

  const commit = commitVideoAnalysisForContext({ context, analysisResult });
  await vi.waitFor(() => expect(setTranscriptionRulesForCache).toHaveBeenCalledWith(
    'cache-1',
    analysisResult.transcriptionRules,
    { expectedProjectId: 'project-1' },
  ));
  expect(openListener).not.toHaveBeenCalled();
  releaseSave();
  await commit;

  expect(assertAutoGenerationContextCurrent).toHaveBeenCalledTimes(3);
  expect(assertAutoGenerationContextDurable).toHaveBeenCalledTimes(3);
  expect(openListener).toHaveBeenCalledWith(expect.objectContaining({
    detail: expect.objectContaining({ context, recommendedPresetId: 'general' }),
  }));
  window.removeEventListener('openRulesEditorWithCountdown', openListener);
});

test('does not publish an editor request when the scoped durable write fails', async () => {
  setTranscriptionRulesForCache.mockRejectedValue(new Error('storage unavailable'));
  const openListener = vi.fn();
  window.addEventListener('openRulesEditorWithCountdown', openListener);

  await expect(commitVideoAnalysisForContext({ context, analysisResult }))
    .rejects.toThrow('storage unavailable');
  expect(openListener).not.toHaveBeenCalled();
  window.removeEventListener('openRulesEditorWithCountdown', openListener);
});
