import { initGeminiButtonEffects, disableGeminiButtonEffects } from '../../../utils/geminiEffects';
import {
  DEFAULT_ANALYSIS_MODEL_ID,
  DEFAULT_GEMINI_MODEL_ID,
  normalizeMediaModelId
} from '../../../config/geminiModels';
import { upsertSingletonCredential } from '../../../platform/credentialStateController';
import { commitNativePreferences } from '../../../platform/preferences/store';
import { LEGACY_SECRET_STORAGE_KEYS } from '../../../platform/preferences/registry';
import { DEFAULT_TRANSCRIPTION_PROMPT } from '../../../services/gemini/promptManagement';
import { normalizeTranscriptionPrompt } from '../../../services/gemini/transcriptionPromptInvariant';
import {
  CREDENTIAL_DRAFT_FIELDS,
  PREFERENCE_FIELDS,
  settingsFormPreferences,
} from './settingsFormFields';

const submitNativeCredentialDrafts = async ({
  geniusApiKey,
  youtubeApiKey,
  youtubeClientId,
  youtubeClientSecret,
}) => {
  if (geniusApiKey?.trim()) {
    await upsertSingletonCredential('geniusAccessToken', geniusApiKey.trim());
  }
  if (youtubeApiKey?.trim()) {
    await upsertSingletonCredential('youtubeApiKey', youtubeApiKey.trim());
  }

  const hasClientId = Boolean(youtubeClientId?.trim());
  const hasClientSecret = Boolean(youtubeClientSecret?.trim());
  if (hasClientId !== hasClientSecret) {
    throw new Error('Both YouTube OAuth client fields are required');
  }
  if (hasClientId) {
    await upsertSingletonCredential('youtubeOauthClient', JSON.stringify({
      clientId: youtubeClientId.trim(),
      clientSecret: youtubeClientSecret.trim(),
    }));
  }
};

/**
 * The Settings modal's save: submits write-only credential drafts to the native vault, commits the
 * form's preferences to SQLite as one batch (which then updates every subscriber), applies Gemini
 * button effects, and records the saved form as the new unchanged baseline.
 *
 * @param {Object} params - the settings form values and setters plus modal callbacks
 * @returns {{ handleSave: () => Promise<void> }}
 */
const useSettingsPersistence = (params) => {
  const {
    geminiModel,
    videoAnalysisModel,
    transcriptionPrompt,
    enableGeminiEffects,
    setOriginalSettings,
    setYoutubeApiKey,
    setGeniusApiKey,
    setYoutubeClientId,
    setYoutubeClientSecret,
    setTranscriptionPrompt,
    onSave,
    handleClose,
  } = params;

  const handleSave = async () => {
    const form = Object.fromEntries(
      [...CREDENTIAL_DRAFT_FIELDS, ...Object.keys(PREFERENCE_FIELDS)].map((field) => [field, params[field]])
    );
    const drafts = {
      geniusApiKey: form.geniusApiKey,
      youtubeApiKey: form.youtubeApiKey,
      youtubeClientId: form.youtubeClientId,
      youtubeClientSecret: form.youtubeClientSecret,
    };
    // Clear every secret-bearing React field before crossing the first async boundary.
    setYoutubeApiKey?.('');
    setGeniusApiKey?.('');
    setYoutubeClientId?.('');
    setYoutubeClientSecret?.('');
    LEGACY_SECRET_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    await submitNativeCredentialDrafts(drafts);

    const saved = {
      ...form,
      ...Object.fromEntries(CREDENTIAL_DRAFT_FIELDS.map((field) => [field, ''])),
      geminiModel: normalizeMediaModelId(geminiModel, DEFAULT_GEMINI_MODEL_ID),
      videoAnalysisModel: normalizeMediaModelId(videoAnalysisModel, DEFAULT_ANALYSIS_MODEL_ID),
      transcriptionPrompt: normalizeTranscriptionPrompt(
        transcriptionPrompt,
        DEFAULT_TRANSCRIPTION_PROMPT
      ),
    };

    // Commit only this form's explicit values. Ambient browser keys are a mirror, not user
    // intent, and must never be swept into the durable preference authority.
    await commitNativePreferences(settingsFormPreferences(saved));
    setTranscriptionPrompt?.(saved.transcriptionPrompt);

    if (enableGeminiEffects) {
      initGeminiButtonEffects();
    } else {
      disableGeminiButtonEffects();
    }

    await onSave();
    setOriginalSettings(saved);
    handleClose();
  };

  return { handleSave };
};

export default useSettingsPersistence;
