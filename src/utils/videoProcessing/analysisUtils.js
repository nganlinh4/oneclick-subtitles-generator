/** Video analysis execution and explicit project-scoped commit helpers. */

import { analyzeVideoWithGemini } from '../../services/videoAnalysisService';
import { PROMPT_PRESETS } from '../../services/gemini/promptManagement';
import { applyTranscriptionPromptPresetSelection } from '../../services/gemini/transcriptionPromptPresetSelection';
import {
  commitVideoAnalysisForCache,
} from '../transcriptionRulesStore';
import {
  assertAutoGenerationContextCurrent,
  assertAutoGenerationContextDurable,
  isAutoGenerationContext,
} from '../autoGenerationOwnership';
import { getActiveProjectSnapshot } from '../../platform/projectService';

const requireContext = async (context) => {
  if (!isAutoGenerationContext(context)) {
    throw new TypeError('A captured analysis project context is required');
  }
  assertAutoGenerationContextCurrent(context);
  return assertAutoGenerationContextDurable(context);
};

/**
 * Execute Gemini analysis without changing rules, prompts, storage, or UI state.
 */
export const analyzeVideoAndWaitForUserChoice = async (
  analysisFile,
  onStatusUpdate,
  t,
  { signal, context = null } = {}
) => {
  onStatusUpdate({
    message: t('output.analyzingVideo', 'Analyzing video content...'),
    type: 'loading',
  });
  await requireContext(context);
  const activeProject = getActiveProjectSnapshot();
  if (activeProject?.metadata?.id !== context.projectId
      || !Number.isSafeInteger(activeProject.stateVersion)
      || activeProject.stateVersion < 0) {
    throw new TypeError('The captured analysis project revision is unavailable');
  }
  const providerResult = await analyzeVideoWithGemini(
    analysisFile,
    onStatusUpdate,
    {
      signal,
      validateOwnership: () => assertAutoGenerationContextDurable(context),
      projectId: context.projectId,
      expectedProjectStateVersion: activeProject.stateVersion,
    }
  );
  await requireContext(context);
  const { analysisResult, delivery } = providerResult;
  const recommendedPresetId = analysisResult?.recommendedPreset?.id || 'settings';
  return {
    analysisResult,
    delivery,
    userChoice: {
      presetId: recommendedPresetId,
      transcriptionRules: analysisResult?.transcriptionRules ?? null,
    },
  };
};

/**
 * Commit a completed analysis only to the captured, still-active project, then
 * publish its editor request. No analysis result may call this without context.
 */
export const commitVideoAnalysisForContext = async ({
  context,
  analysisResult,
  delivery,
  showCountdown = true,
}) => {
  await requireContext(context);
  const rules = analysisResult?.transcriptionRules ?? null;
  if (rules === null
      || typeof delivery?.jobId !== 'string'
      || typeof delivery?.deliveryId !== 'string'
      || typeof delivery?.acknowledge !== 'function') {
    const error = new Error('The provider analysis has no durable delivery ownership');
    error.code = 'invalidVideoAnalysisDelivery';
    throw error;
  }
  const recommendedPresetId = analysisResult?.recommendedPreset?.id || 'settings';
  await commitVideoAnalysisForCache(context.cacheId, {
    rules,
    analysis: {
      schemaVersion: 1,
      sourceIdentity: context.sourceIdentity,
      providerJobId: delivery.jobId,
      deliveryId: delivery.deliveryId,
      recommendedPresetId,
      transcriptionRules: rules,
    },
  }, { expectedProjectId: context.projectId });
  await requireContext(context);
  await delivery.acknowledge();
  await requireContext(context);

  applyTranscriptionPromptPresetSelection({
    requestedPresetId: recommendedPresetId,
    availablePresets: PROMPT_PRESETS,
    defaultPrompt: PROMPT_PRESETS[0]?.prompt,
  });
  sessionStorage.setItem('current_session_preset_id', recommendedPresetId);
  sessionStorage.setItem('current_session_video_fingerprint', context.sourceIdentity);
  await requireContext(context);
  window.dispatchEvent(new CustomEvent('openRulesEditorWithCountdown', {
    detail: {
      context,
      transcriptionRules: rules,
      analysisResult,
      recommendedPresetId,
      showCountdown,
    },
  }));
  return {
    presetId: recommendedPresetId,
    transcriptionRules: rules,
  };
};
