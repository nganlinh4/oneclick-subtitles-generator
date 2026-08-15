/** Video analysis execution and explicit project-scoped commit helpers. */

import { analyzeVideoWithGemini } from '../../services/videoAnalysisService';
import { PROMPT_PRESETS } from '../../services/gemini/promptManagement';
import {
  setTranscriptionRulesForCache,
} from '../transcriptionRulesStore';
import {
  assertAutoGenerationContextCurrent,
  assertAutoGenerationContextDurable,
  isAutoGenerationContext,
} from '../autoGenerationOwnership';

const requireContext = async (context) => {
  if (!isAutoGenerationContext(context)) {
    throw new TypeError('A captured analysis project context is required');
  }
  assertAutoGenerationContextCurrent(context);
  return assertAutoGenerationContextDurable(context);
};

const persistPresentationCopy = (analysisResult) => {
  try {
    const encoded = JSON.stringify(analysisResult);
    if (encoded.length <= 4 * 1024 * 1024) {
      localStorage.setItem('video_analysis_result', encoded);
    }
  } catch {
    // The durable project rules remain authoritative; this copy only restores presentation state.
  }
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
  if (context) await assertAutoGenerationContextDurable(context);
  const analysisResult = await analyzeVideoWithGemini(
    analysisFile,
    onStatusUpdate,
    {
      signal,
      ...(context ? {
        validateOwnership: () => assertAutoGenerationContextDurable(context),
      } : {}),
    }
  );
  if (context) await assertAutoGenerationContextDurable(context);
  const recommendedPresetId = analysisResult?.recommendedPreset?.id || 'settings';
  return {
    analysisResult,
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
  showCountdown = true,
}) => {
  await requireContext(context);
  const rules = analysisResult?.transcriptionRules ?? null;
  if (rules) {
    await setTranscriptionRulesForCache(context.cacheId, rules, {
      expectedProjectId: context.projectId,
    });
  }
  await requireContext(context);

  const recommendedPresetId = analysisResult?.recommendedPreset?.id || 'settings';
  localStorage.setItem('video_processing_prompt_preset', recommendedPresetId);
  sessionStorage.setItem('current_session_preset_id', recommendedPresetId);
  sessionStorage.setItem('current_session_video_fingerprint', context.sourceIdentity);
  const preset = PROMPT_PRESETS.find(({ id }) => id === recommendedPresetId);
  if (preset) sessionStorage.setItem('current_session_prompt', preset.prompt);
  else sessionStorage.removeItem('current_session_prompt');
  persistPresentationCopy(analysisResult);

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
