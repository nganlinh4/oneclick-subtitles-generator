// Translation request preferences, mirrored to best-effort localStorage compatibility keys.
import { useCallback, useState } from 'react';
import { DEFAULT_TRANSLATION_MODEL_ID, migrateGeminiModelId } from '../config/geminiModels';
import { boundedIntegerSetting, safeGetStorage, safeSetStorage } from './translationRunHelpers';

export const useTranslationPreferences = () => {
  const [selectedModel, setSelectedModel] = useState(() => migrateGeminiModelId(
    safeGetStorage('translation_model') || safeGetStorage('gemini_model'),
    DEFAULT_TRANSLATION_MODEL_ID
  ));
  const [customTranslationPrompt, setCustomTranslationPrompt] = useState(
    () => safeGetStorage('custom_prompt_translation') || null
  );
  const [splitDuration, setSplitDuration] = useState(
    () => boundedIntegerSetting('translation_split_duration', 0, 24 * 60)
  );
  const [restTime, setRestTime] = useState(
    () => boundedIntegerSetting('translation_rest_time', 0, 24 * 60 * 60)
  );
  const [includeRules, setIncludeRules] = useState(
    () => safeGetStorage('translation_include_rules') === 'true'
  );

  const handleModelSelect = useCallback((modelId) => {
    setSelectedModel(modelId);
    safeSetStorage('translation_model', modelId);
  }, []);

  const handleSavePrompt = useCallback((prompt) => {
    setCustomTranslationPrompt(prompt);
    safeSetStorage('custom_prompt_translation', prompt);
  }, []);

  const handleSplitDurationChange = useCallback((value) => {
    setSplitDuration(value);
    safeSetStorage('translation_split_duration', String(value));
  }, []);
  const handleRestTimeChange = useCallback((value) => {
    setRestTime(value);
    safeSetStorage('translation_rest_time', String(value));
  }, []);
  const handleIncludeRulesChange = useCallback((value) => {
    setIncludeRules(value);
    safeSetStorage('translation_include_rules', String(value));
  }, []);

  return {
    selectedModel,
    customTranslationPrompt,
    splitDuration,
    restTime,
    includeRules,
    setIncludeRules,
    handleModelSelect,
    handleSavePrompt,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
  };
};
