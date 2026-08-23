import { analyzeVideoWithGemini } from '../../services/videoAnalysisService';
import { commitVideoAnalysisForCache } from '../transcriptionRulesStore';
import {
  assertAutoGenerationContextDurable,
} from '../autoGenerationOwnership';
import {
  analyzeVideoAndWaitForUserChoice,
  commitVideoAnalysisForContext,
} from './analysisUtils';

vi.mock('../../services/videoAnalysisService', () => ({ analyzeVideoWithGemini: vi.fn() }));
vi.mock('../../platform/projectService', () => ({
  getActiveProjectSnapshot: vi.fn(() => ({
    metadata: { id: 'project-1' },
    stateVersion: 12,
  })),
}));
vi.mock('../../services/gemini/promptManagement', () => ({
  PROMPT_PRESETS: [{ id: 'general', prompt: 'General {contentType}' }],
}));
vi.mock('../transcriptionRulesStore', () => ({ commitVideoAnalysisForCache: vi.fn() }));
vi.mock('../autoGenerationOwnership', () => ({
  assertAutoGenerationContextCurrent: vi.fn((context) => context),
  assertAutoGenerationContextDurable: vi.fn(async (context) => context),
  isAutoGenerationContext: vi.fn((value) => value?.projectId === 'project-1'),
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
const delivery = Object.freeze({
  jobId: '01890f39-7b62-7c4e-8c9a-000000000311',
  deliveryId: '01890f39-7b62-7c4e-8c9a-000000000312',
  acknowledge: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  delivery.acknowledge.mockReset();
  delivery.acknowledge.mockResolvedValue(undefined);
  analyzeVideoWithGemini.mockResolvedValue({ analysisResult, delivery });
  commitVideoAnalysisForCache.mockResolvedValue({
    projectId: context.projectId,
    providerJobId: delivery.jobId,
    deliveryId: delivery.deliveryId,
  });
});

test('analysis refuses to create an unowned durable provider result', async () => {
  const openListener = vi.fn();
  window.addEventListener('openRulesEditorWithCountdown', openListener);
  const signal = new AbortController().signal;

  await expect(analyzeVideoAndWaitForUserChoice(
    { assetId: 'asset-1' },
    vi.fn(),
    (_key, fallback) => fallback,
    { signal },
  )).rejects.toThrow('captured analysis project context');

  expect(analyzeVideoWithGemini).not.toHaveBeenCalled();
  expect(commitVideoAnalysisForCache).not.toHaveBeenCalled();
  expect(openListener).not.toHaveBeenCalled();
  expect(localStorage.getItem('video_processing_prompt_preset')).toBeNull();
  window.removeEventListener('openRulesEditorWithCountdown', openListener);
});

test('validates the captured project on both sides of native analysis', async () => {
  await expect(analyzeVideoAndWaitForUserChoice(
    { assetId: 'asset-1' },
    vi.fn(),
    (_key, fallback) => fallback,
    { signal: context.signal, context },
  )).resolves.toMatchObject({ analysisResult, delivery });

  expect(analyzeVideoWithGemini).toHaveBeenCalledWith(
    { assetId: 'asset-1' },
    expect.any(Function),
    {
      signal: context.signal,
      validateOwnership: expect.any(Function),
      projectId: 'project-1',
      expectedProjectStateVersion: 12,
    },
  );
  await analyzeVideoWithGemini.mock.calls[0][2].validateOwnership();
  expect(assertAutoGenerationContextDurable).toHaveBeenCalledTimes(3);
});

test('awaits the exact project write before publishing the editor request', async () => {
  let releaseSave;
  commitVideoAnalysisForCache.mockReturnValue(
    new Promise((resolve) => { releaseSave = resolve; })
  );
  const openListener = vi.fn();
  window.addEventListener('openRulesEditorWithCountdown', openListener);

  const commit = commitVideoAnalysisForContext({ context, analysisResult, delivery });
  await vi.waitFor(() => expect(commitVideoAnalysisForCache).toHaveBeenCalledWith(
    'cache-1',
    {
      rules: analysisResult.transcriptionRules,
      analysis: {
        schemaVersion: 1,
        sourceIdentity: context.sourceIdentity,
        providerJobId: delivery.jobId,
        deliveryId: delivery.deliveryId,
        recommendedPresetId: 'general',
        transcriptionRules: analysisResult.transcriptionRules,
      },
    },
    { expectedProjectId: 'project-1' },
  ));
  expect(openListener).not.toHaveBeenCalled();
  releaseSave();
  await commit;

  expect(commitVideoAnalysisForCache).toHaveBeenCalledBefore(delivery.acknowledge);
  expect(delivery.acknowledge).toHaveBeenCalledTimes(1);
  expect(openListener).toHaveBeenCalledWith(expect.objectContaining({
    detail: expect.objectContaining({ context, recommendedPresetId: 'general' }),
  }));
  window.removeEventListener('openRulesEditorWithCountdown', openListener);
});

test('does not publish an editor request when the scoped durable write fails', async () => {
  commitVideoAnalysisForCache.mockRejectedValue(new Error('storage unavailable'));
  const openListener = vi.fn();
  window.addEventListener('openRulesEditorWithCountdown', openListener);

  await expect(commitVideoAnalysisForContext({ context, analysisResult, delivery }))
    .rejects.toThrow('storage unavailable');
  expect(openListener).not.toHaveBeenCalled();
  expect(delivery.acknowledge).not.toHaveBeenCalled();
  window.removeEventListener('openRulesEditorWithCountdown', openListener);
});

test('keeps an accepted analysis pending when delivery acknowledgement fails', async () => {
  delivery.acknowledge.mockRejectedValue(new Error('ack transport unavailable'));
  const openListener = vi.fn();
  window.addEventListener('openRulesEditorWithCountdown', openListener);

  await expect(commitVideoAnalysisForContext({ context, analysisResult, delivery }))
    .rejects.toThrow('ack transport unavailable');

  expect(commitVideoAnalysisForCache).toHaveBeenCalledTimes(1);
  expect(openListener).not.toHaveBeenCalled();
  window.removeEventListener('openRulesEditorWithCountdown', openListener);
});
