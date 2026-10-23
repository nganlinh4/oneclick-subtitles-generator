// Translation request preferences of this device.
import { useCallback } from 'react';
import { DEFAULT_TRANSLATION_MODEL_ID, migrateGeminiModelId } from '../config/geminiModels';
import { hasStoredPreference, readPreference, usePreference } from '../platform/preferences/store';

export const useTranslationPreferences = () => {
  const [storedModel, handleModelSelect] = usePreference('translation_model');
  // Without a translation choice, follow an explicit Settings model, else the translation default.
  const selectedModel = migrateGeminiModelId(
    storedModel || (hasStoredPreference('gemini_model') ? readPreference('gemini_model') : null),
    DEFAULT_TRANSLATION_MODEL_ID
  );
  const [storedPrompt, setStoredPrompt] = usePreference('custom_prompt_translation');
  const customTranslationPrompt = storedPrompt || null;
  const handleSavePrompt = useCallback((prompt) => setStoredPrompt(prompt ?? ''), [setStoredPrompt]);
  const [splitDuration, handleSplitDurationChange] = usePreference('translation_split_duration');
  const [restTime, handleRestTimeChange] = usePreference('translation_rest_time');
  const [includeRules, handleIncludeRulesChange] = usePreference('translation_include_rules');

  return {
    selectedModel,
    customTranslationPrompt,
    splitDuration,
    restTime,
    includeRules,
    handleModelSelect,
    handleSavePrompt,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
  };
};
