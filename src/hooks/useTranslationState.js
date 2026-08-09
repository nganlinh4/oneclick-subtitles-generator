import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { translateSubtitles, /* abortAllRequests, */ cancelTranslation, setProcessingForceStopped, getProcessingForceStopped } from '../services/geminiService';
import { generateSubtitleHash } from '../utils/subtitle/subtitleHash';
import { getCurrentMediaId } from '../utils/mediaId';
import { useTranslationCaching, saveTranslationsToCache, clearTranslationCache } from './useTranslationCaching';
import { useTranslationBulk } from './useTranslationBulk';
import { DEFAULT_TRANSLATION_MODEL_ID, migrateGeminiModelId } from '../config/geminiModels';

// Re-export the shared helpers for existing consumers (e.g. translation/index.js).
export { generateSubtitleHash, getCurrentMediaId };

/**
 * Custom hook to manage translation state
 * @param {Array} subtitles - Subtitles to translate
 * @param {Function} onTranslationComplete - Callback when translation is complete
 * @returns {Object} - Translation state and handlers
 */
export const useTranslationState = (subtitles, onTranslationComplete) => {
  const { t } = useTranslation();
  const [isTranslating, setIsTranslating] = useState(false);
  const [translatedSubtitles, setTranslatedSubtitles] = useState(null);
  const [error, setError] = useState('');
  const [translationStatus, setTranslationStatus] = useState('');
  const [loadedFromCache, setLoadedFromCache] = useState(false);
  const [wasManuallyReset, setWasManuallyReset] = useState(false);

  // Use a translation-specific model selection that's independent from settings
  const [selectedModel, setSelectedModel] = useState(() => {
    // Get the model from translation-specific localStorage key or use the global setting as default
    return migrateGeminiModelId(
      localStorage.getItem('translation_model') || localStorage.getItem('gemini_model'),
      DEFAULT_TRANSLATION_MODEL_ID
    );
  });
  const [customTranslationPrompt, setCustomTranslationPrompt] = useState(
    localStorage.getItem('custom_prompt_translation') || null
  );
  const [splitDuration, setSplitDuration] = useState(() => {
    // Get the split duration from localStorage or use default (0 = no split)
    return parseInt(localStorage.getItem('translation_split_duration') || '0');
  });
  const [restTime, setRestTime] = useState(() => {
    // Get the rest time from localStorage or use default (0 = no rest)
    return parseInt(localStorage.getItem('translation_rest_time') || '0');
  });
  const [includeRules, setIncludeRules] = useState(() => {
    // Get the preference from localStorage, but default to false
    // It will be updated to true only if rules are available
    return localStorage.getItem('translation_include_rules') === 'true';
  });
  const [rulesAvailable, setRulesAvailable] = useState(false);
  const [userProvidedSubtitles, setUserProvidedSubtitles] = useState('');
  const hasUserProvidedSubtitles = userProvidedSubtitles.trim() !== '';

  // Reference to the status message element for scrolling
  const statusRef = useRef(null);

  // Bulk translation state and handlers (composed sub-hook)
  const {
    bulkFiles,
    setBulkFiles,
    bulkTranslations,
    setBulkTranslations,
    isBulkTranslating,
    setIsBulkTranslating,
    currentBulkFileIndex,
    setCurrentBulkFileIndex,
    handleBulkTranslate,
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll
  } = useTranslationBulk({
    selectedModel,
    splitDuration,
    setError,
    setTranslationStatus,
    t
  });

  // No longer update selectedModel when localStorage changes
  // This keeps the translation model independent from the settings

  // Listen for translation status updates
  useEffect(() => {
    const handleTranslationStatus = (event) => {
      const { message } = event.detail;
      setTranslationStatus(message);
      // Removed auto-scrolling behavior to prevent viewport jumping
    };

    window.addEventListener('translation-status', handleTranslationStatus);
    return () => window.removeEventListener('translation-status', handleTranslationStatus);
  }, []);

  // Load translations from cache on component mount (composed sub-hook)
  useTranslationCaching({
    subtitles,
    translatedSubtitles,
    wasManuallyReset,
    onTranslationComplete,
    setTranslatedSubtitles,
    setLoadedFromCache,
    setTranslationStatus,
    t
  });

  // Check if transcription rules are available
  useEffect(() => {
    const checkRulesAvailability = async () => {
      try {
        // Dynamically import to avoid circular dependencies
        const { getTranscriptionRulesSync } = await import('../utils/transcriptionRulesStore');
        const rules = getTranscriptionRulesSync();
        const hasRules = !!rules;
        setRulesAvailable(hasRules);

        // If rules are not available, set includeRules to false
        if (!hasRules) {
          setIncludeRules(false);
          localStorage.setItem('translation_include_rules', 'false');
        }


      } catch (error) {
        console.error('Error checking transcription rules availability:', error);
        setRulesAvailable(false);
        setIncludeRules(false);
        localStorage.setItem('translation_include_rules', 'false');
      }
    };

    // Initial check
    checkRulesAvailability();

    // Listen for transcription rules updates
    const handleRulesUpdate = () => {
      checkRulesAvailability();
    };

    // Listen for video analysis completion
    const handleAnalysisComplete = () => {
      checkRulesAvailability();
    };

    // Add event listeners
    window.addEventListener('transcriptionRulesUpdated', handleRulesUpdate);
    window.addEventListener('videoAnalysisComplete', handleAnalysisComplete);
    window.addEventListener('videoAnalysisUserChoice', handleAnalysisComplete);

    // Cleanup event listeners
    return () => {
      window.removeEventListener('transcriptionRulesUpdated', handleRulesUpdate);
      window.removeEventListener('videoAnalysisComplete', handleAnalysisComplete);
      window.removeEventListener('videoAnalysisUserChoice', handleAnalysisComplete);
    };
  }, []);

  // Load user-provided subtitles
  useEffect(() => {
    const loadUserProvidedSubtitles = async () => {
      try {
        // Dynamically import to avoid circular dependencies
        const { getUserProvidedSubtitlesSync } = await import('../utils/userSubtitlesStore');
        const subtitles = getUserProvidedSubtitlesSync();
        setUserProvidedSubtitles(subtitles || '');

        // If user-provided subtitles are present, set includeRules to false
        if (subtitles && subtitles.trim() !== '') {
          setIncludeRules(false);
          localStorage.setItem('translation_include_rules', 'false');
        }


      } catch (error) {
        console.error('Error loading user-provided subtitles:', error);
        setUserProvidedSubtitles('');
      }
    };

    loadUserProvidedSubtitles();
  }, []);

  /**
   * Handle model selection for translation only
   * @param {string} modelId - Selected model ID
   */
  const handleModelSelect = (modelId) => {
    // Update the local state
    setSelectedModel(modelId);
    // Save to translation-specific localStorage key to remember the choice
    // This keeps the translation model independent from the settings
    localStorage.setItem('translation_model', modelId);
  };

  /**
   * Handle saving custom prompt
   * @param {string} newPrompt - New custom prompt
   */
  const handleSavePrompt = (newPrompt) => {
    setCustomTranslationPrompt(newPrompt);
    localStorage.setItem('custom_prompt_translation', newPrompt);
  };

  /**
   * Handle translation (includes both main and bulk translation)
   * @param {Array} languages - Languages to translate to
   * @param {string|null} delimiter - Delimiter for multi-language translation
   * @param {boolean} useParentheses - Whether to use parentheses for the second language
   * @param {Object} bracketStyle - Optional bracket style { open, close }
   * @param {Array} chainItems - Optional chain items for format mode
   */
  const handleTranslate = async (languages, delimiter = ' ', useParentheses = false, bracketStyle = null, chainItems = null) => {
    // Reset the processing force stopped flag at the start of any new translation
    setProcessingForceStopped(false);

    // Check if at least one language is entered (unless in format mode with chainItems)
    if (languages.length === 0 && !chainItems) {
      setError(t('translation.languageRequired', 'Please enter at least one target language'));
      return;
    }

    // Check if we have main subtitles to translate
    const hasMainSubtitles = subtitles && subtitles.length > 0;
    const hasBulkFiles = bulkFiles.length > 0;

    if (!hasMainSubtitles && !hasBulkFiles) {
      setError(t('translation.noSubtitles', 'No subtitles to translate'));
      return;
    }

    // If there are bulk files, handle bulk translation first
    if (hasBulkFiles) {
      await handleBulkTranslate(languages, delimiter, useParentheses, bracketStyle, chainItems, hasMainSubtitles);

      // Check if bulk translation was cancelled - if so, don't continue with main translation
      if (getProcessingForceStopped()) {
        console.log('Bulk translation was cancelled, skipping main translation');
        return;
      }
    }

    // Continue with main translation if there are main subtitles
    if (!hasMainSubtitles) {
      return;
    }

    // Check if processing has been force stopped before starting main translation
    if (getProcessingForceStopped()) {
      console.log('Translation was cancelled before main translation could start');
      return;
    }

    setError('');
    setIsTranslating(true);

    // Reset the manual reset flag when starting a new translation
    setWasManuallyReset(false);

    try {
      // For 2 target languages, we can use both delimiter and brackets
      // For 3+ languages, we only use delimiter
      const useBothOptions = languages.length === 2 && useParentheses;

      // Pass the selected model, custom prompt, split duration, includeRules, delimiter and parentheses options
      const result = await translateSubtitles(
        subtitles,
        languages.length === 1 ? languages[0] : languages,
        selectedModel,
        customTranslationPrompt,
        splitDuration,
        includeRules,
        useBothOptions ? delimiter : (useParentheses ? null : delimiter), // Pass delimiter even when using parentheses for 2 languages
        useParentheses,
        bracketStyle, // Pass the bracket style
        chainItems, // Pass the chain items for format mode
        'main' // File context for main translation
      );


      // Check if result is valid
      if (!result || result.length === 0) {
        console.error('Translation returned empty result');
        setError(t('translation.emptyResult', 'Translation returned no results. Please try again or check the console for errors.'));
        return;
      }

      // Save translations to cache
      saveTranslationsToCache(subtitles, result);

      setTranslatedSubtitles(result);

      // Update final status if bulk translations were also completed
      if (bulkTranslations.length > 0) {
        const successfulBulkFiles = bulkTranslations.filter(r => r.success).length;
        const totalFiles = bulkTranslations.length + 1; // +1 for main file
        const totalSuccessful = successfulBulkFiles + 1; // +1 for main file (which just succeeded)

        setTranslationStatus(t('translation.allComplete', 'All translations complete: {{success}}/{{total}} files processed successfully', {
          success: totalSuccessful,
          total: totalFiles
        }));
      }

      if (onTranslationComplete) {
        onTranslationComplete(result);
      }

      // Dispatch a custom event to notify other components that translation is complete
      window.dispatchEvent(new CustomEvent('translation-complete', {
        detail: {
          translatedSubtitles: result,
          loadedFromCache: false
        }
      }));


      // Save the split duration setting to localStorage
      localStorage.setItem('translation_split_duration', splitDuration.toString());
    } catch (err) {
      console.error('Translation error:', err);

      // Check if this was a cancellation
      if (err.message && (err.message.includes('cancelled') || err.message.includes('aborted'))) {
        setTranslationStatus(t('translation.cancelled', 'Translation cancelled by user'));
      } else {
        // Use the specific error message if available, otherwise use generic message
        setError(err.message || t('translation.error', 'Error translating subtitles. Please try again.'));
      }
    } finally {
      setIsTranslating(false);
    }
  };

  /**
   * Handle cancellation of translation
   */
  const handleCancelTranslation = () => {

    // Call the cancelTranslation function from the translation service
    // This will abort all active requests and set the processingForceStopped flag to true
    // Note: The processingForceStopped flag will be reset to false when starting a new translation
    // or when resetting the translation
    /* const aborted = */ cancelTranslation();

    // Update UI state for both main and bulk translation
    setIsTranslating(false);
    setIsBulkTranslating(false);
    setCurrentBulkFileIndex(-1);
    setError(t('translation.cancelled', 'Translation cancelled by user'));

    // Update translation status to show cancellation
    setTranslationStatus(t('translation.cancelled', 'Translation cancelled by user'));
  };

  /**
   * Handle reset of translation
   */
  const handleReset = () => {
    console.log('Manual translation reset initiated');

    setTranslatedSubtitles(null);
    setError('');
    setLoadedFromCache(false);

    // Set the manual reset flag to prevent cache loading
    setWasManuallyReset(true);

    // Reset the processing force stopped flag when resetting translation
    setProcessingForceStopped(false);

    // Clear the translation cache
    clearTranslationCache();

    if (onTranslationComplete) {
      onTranslationComplete(null);
    }

    // Dispatch a custom event to notify other components that translation has been reset
    window.dispatchEvent(new CustomEvent('translation-reset', {
      detail: {
        translatedSubtitles: null
      }
    }));

  };

  /**
   * Handle split duration change
   * @param {number} value - New split duration value
   */
  const handleSplitDurationChange = (value) => {
    setSplitDuration(value);
    localStorage.setItem('translation_split_duration', value.toString());
  };

  /**
   * Handle rest time change
   * @param {number} value - New rest time value in seconds
   */
  const handleRestTimeChange = (value) => {
    setRestTime(value);
    localStorage.setItem('translation_rest_time', value.toString());
  };

  /**
   * Handle include rules toggle
   * @param {boolean} value - New include rules value
   */
  const handleIncludeRulesChange = (value) => {
    setIncludeRules(value);
    localStorage.setItem('translation_include_rules', value.toString());
  };

  // Function to update translated subtitles (for segment retry)
  const updateTranslatedSubtitles = useCallback((newTranslatedSubtitles) => {
    setTranslatedSubtitles(newTranslatedSubtitles);
  }, []);

  return {
    isTranslating,
    translatedSubtitles,
    error,
    translationStatus,
    selectedModel,
    customTranslationPrompt,
    splitDuration,
    restTime,
    includeRules,
    rulesAvailable,
    hasUserProvidedSubtitles,
    loadedFromCache,
    statusRef,
    handleModelSelect,
    handleSavePrompt,
    handleTranslate,
    handleCancelTranslation,
    handleReset,
    handleSplitDurationChange,
    handleRestTimeChange,
    handleIncludeRulesChange,
    updateTranslatedSubtitles,
    // Bulk translation
    bulkFiles,
    setBulkFiles,
    bulkTranslations,
    setBulkTranslations,
    isBulkTranslating,
    currentBulkFileIndex,
    handleBulkTranslate,
    handleBulkFileRemoval,
    handleBulkFilesRemovalAll
  };
};

export default useTranslationState;
