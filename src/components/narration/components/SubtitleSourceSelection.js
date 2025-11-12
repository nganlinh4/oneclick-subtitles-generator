import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import MaterialSwitch from '../../common/MaterialSwitch';
import LoadingIndicator from '../../common/LoadingIndicator';
import CustomDropdown from '../../common/CustomDropdown';
import '../../../styles/common/material-switch.css';
import { detectSubtitleLanguage } from '../../../services/gemini/languageDetectionService';
import {
  getAvailableModels,
  MODEL_LIST_CHANGED_EVENT
} from '../../../services/modelAvailabilityService';
import '../../../styles/narration/modelDropdown.css';
import '../../../styles/narration/languageBadges.css';
import '../../../styles/narration/narrationModelDropdown.css';
import '../../../styles/ModelDropdown.css';
import '../../../styles/narration/subtitleSourceSelectionMaterial.css';
import SubtitleGroupingModal from './SubtitleGroupingModal';
import ModelSelectionModal from './ModelSelectionModal';
import ManualLanguageSelectionModal from './ManualLanguageSelectionModal';
import HelpIcon from '../../common/HelpIcon';
import { showErrorToast } from '../../../utils/toastUtils';

/**
 * Subtitle Source Selection component
 * @param {Object} props - Component props
 * @param {string} props.subtitleSource - Current subtitle source
 * @param {Function} props.setSubtitleSource - Function to set subtitle source
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @param {Array} props.translatedSubtitles - Translated subtitles
 * @param {Array} props.originalSubtitles - Original subtitles
 * @param {Object} props.originalLanguage - Original language information
 * @param {Object} props.translatedLanguage - Translated language information
 * @param {Function} props.setOriginalLanguage - Function to set original language
 * @param {Function} props.setTranslatedLanguage - Function to set translated language
 * @param {Function} props.onLanguageDetected - Callback when language is detected
 * @param {boolean} props.useGroupedSubtitles - Whether to use grouped subtitles for narration
 * @param {Function} props.setUseGroupedSubtitles - Function to set whether to use grouped subtitles
 * @param {boolean} props.isGroupingSubtitles - Whether subtitles are currently being grouped
 * @param {Array} props.groupedSubtitles - Grouped subtitles
 * @param {string} props.groupingIntensity - Intensity level for subtitle grouping
 * @param {Function} props.setGroupingIntensity - Function to set grouping intensity
 * @param {string} props.narrationMethod - Current narration method
 * @param {string} props.chatterboxLanguage - Selected language for Chatterbox
 * @param {Function} props.setChatterboxLanguage - Function to set Chatterbox language
 * @param {string} props.selectedModel - Selected narration model
 * @param {Function} props.setSelectedModel - Function to set selected model
 * @returns {JSX.Element} - Rendered component
 */
const SubtitleSourceSelection = ({
  subtitleSource,
  setSubtitleSource,
  isGenerating,
  translatedSubtitles,
  originalSubtitles,
  originalLanguage,
  translatedLanguage,
  setOriginalLanguage,
  setTranslatedLanguage,
  onLanguageDetected,
  useGroupedSubtitles = false,
  setUseGroupedSubtitles = () => {},
  isGroupingSubtitles = false,
  groupedSubtitles = null,
  groupingIntensity = 'moderate',
  setGroupingIntensity = () => {},
  narrationMethod = 'f5tts',
  chatterboxLanguage = 'en',
  setChatterboxLanguage = () => {},
  selectedModel = null,
  setSelectedModel = () => {}
}) => {
  const { t } = useTranslation();
  const hasTranslatedSubtitles = translatedSubtitles && translatedSubtitles.length > 0;
  const hasOriginalSubtitles = originalSubtitles && originalSubtitles.length > 0;
  const hasSubtitles = hasOriginalSubtitles || hasTranslatedSubtitles;

  // State for subtitle grouping modal
  const [isModalOpen, setIsModalOpen] = useState(false);

  // State for manual language selection modal
  const [isManualLanguageModalOpen, setIsManualLanguageModalOpen] = useState(false);
  const [manualLanguageSource, setManualLanguageSource] = useState(null);

  // State for hover detection on radio pills (for manual button visibility)
  const [hoveredPill, setHoveredPill] = useState(null);


  // Function to handle subtitle grouping toggle
  const handleGroupingToggle = async (checked) => {
    if (checked) {
      // Clear the user disabled flag since they're turning it back on
      try {
        localStorage.removeItem('user_disabled_grouping');
      } catch (error) {
        console.error('Error clearing user disabled grouping flag:', error);
      }

      // If turning on, check if we already have grouped subtitles
      if (groupedSubtitles && groupedSubtitles.length > 0) {
        // We already have grouped subtitles, just enable the toggle
        setUseGroupedSubtitles(true);
        return;
      }

      // No existing grouped subtitles, we need to group them
      try {
        // Set grouping state to true to show loading indicator
        if (typeof window.setIsGroupingSubtitles === 'function') {
          window.setIsGroupingSubtitles(true);
        }

        // We don't need to update the local isGroupingSubtitles prop
        // as it's handled by the parent component through window.setIsGroupingSubtitles

        // Import the subtitle grouping service
        const { groupSubtitlesForNarration } = await import('../../../services/gemini/subtitleGroupingService');

        // Get the appropriate subtitles based on the selected source
        const subtitlesToGroup = subtitleSource === 'translated' && hasTranslatedSubtitles
          ? translatedSubtitles
          : originalSubtitles;

        // Get the language code for the selected subtitles
        const languageCode = subtitleSource === 'translated' && translatedLanguage
          ? translatedLanguage.languageCode
          : originalLanguage?.languageCode || 'en';

        // Group the subtitles
        const result = await groupSubtitlesForNarration(
          subtitlesToGroup,
          languageCode,
          'gemini-2.5-flash-lite',
          groupingIntensity
        );

        // Update the grouped subtitles
        if (result && result.success && result.groupedSubtitles) {
          // Update the grouped subtitles state in the parent component
          window.groupedSubtitles = result.groupedSubtitles;
          // If the parent component provided a function to update grouped subtitles, call it
          if (typeof window.setGroupedSubtitles === 'function') {
            window.setGroupedSubtitles(result.groupedSubtitles);
          }
          setUseGroupedSubtitles(true);
        } else {
          // If grouping failed, don't enable the toggle
          setUseGroupedSubtitles(false);
        }
      } catch (error) {
        console.error('Error grouping subtitles:', error);
        setUseGroupedSubtitles(false);
      } finally {
        // Reset grouping state after a short delay to ensure the UI updates properly
        setTimeout(() => {
          if (typeof window.setIsGroupingSubtitles === 'function') {
            window.setIsGroupingSubtitles(false);
          }
        }, 500);
      }
    } else {
      // If turning off, clear the grouping data and update the state
      setUseGroupedSubtitles(false);

      // Clear the grouped subtitles data
      window.groupedSubtitles = null;
      if (typeof window.setGroupedSubtitles === 'function') {
        window.setGroupedSubtitles(null);
      }

      // Set flag to prevent auto-loading from cache
      try {
        localStorage.setItem('user_disabled_grouping', 'true');
      } catch (error) {
        console.error('Error setting user disabled grouping flag:', error);
      }
    }
  };

  // Functions to handle modal
  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

  // Functions to handle manual language modal
  const openManualLanguageModal = (source) => {
    setManualLanguageSource(source);
    setIsManualLanguageModalOpen(true);
  };
  const closeManualLanguageModal = () => {
    setIsManualLanguageModalOpen(false);
    setManualLanguageSource(null);
  };

  // Handle manual language save
  const handleManualLanguageSave = (languages) => {
    if (!manualLanguageSource) return;

    // If no languages selected, clear the language selection
    if (!languages || languages.length === 0) {
      if (manualLanguageSource === 'original') {
        setOriginalLanguage(null);
      } else if (manualLanguageSource === 'translated') {
        setTranslatedLanguage(null);
      }
      return;
    }

    // Create a manual language object
    const manualLanguage = {
      languageCode: languages[0] || 'unknown',
      secondaryLanguages: languages.length > 1 ? languages.slice(1) : [],
      isMultiLanguage: languages.length > 1,
      isManualSelection: true,
      confidence: 1.0 // Manual selection has full confidence
    };

    // Set the language based on source
    if (manualLanguageSource === 'original') {
      setOriginalLanguage(manualLanguage);
    } else if (manualLanguageSource === 'translated') {
      setTranslatedLanguage(manualLanguage);
    }

    // Call the callback if provided
    if (onLanguageDetected) {
      onLanguageDetected(manualLanguageSource, manualLanguage);
    }
  };

  // State for language detection
  const [isDetectingOriginal, setIsDetectingOriginal] = useState(false);
  const [isDetectingTranslated, setIsDetectingTranslated] = useState(false);
  const [modelError, setModelError] = useState(null);
  const [isCheckingModel, setIsCheckingModel] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [userHasManuallySelectedModel, setUserHasManuallySelectedModel] = useState(false);
  const [userHasManuallySelectedChatterboxLanguage, setUserHasManuallySelectedChatterboxLanguage] = useState(false);

  // Keep a stable reference to the last detected languages so a transient null
  // in state (during quick UI switches) doesn't show the refresh button briefly.
  const lastOriginalLanguageRef = React.useRef(null);
  const lastTranslatedLanguageRef = React.useRef(null);

  // Load available models
  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true);
      try {
        const { models } = await getAvailableModels();
        setAvailableModels(models || []);
      } catch (error) {
        console.error('Error loading models:', error);
        setAvailableModels([]);
      } finally {
        setIsLoadingModels(false);
      }
    };

    // Load models initially
    loadModels();

    // Listen for model list changes
    const handleModelListChanged = () => {

      loadModels();
    };

    // Add event listener
    window.addEventListener(MODEL_LIST_CHANGED_EVENT, handleModelListChanged);

    // Clean up event listener
    return () => {
      window.removeEventListener(MODEL_LIST_CHANGED_EVENT, handleModelListChanged);
    };
  }, []);

  // Detect changes in translated subtitles
  useEffect(() => {
    // If translated subtitles exist and the user has selected the translated source,
    // only trigger detection when the subtitles themselves change AND we don't already
    // have a detected translated language. This prevents re-running detection when the
    // user simply switches the radio pill between original/translated.
    if (translatedSubtitles &&
        translatedSubtitles.length > 0 &&
        subtitleSource === 'translated') {

      if (!translatedLanguage) {
        // Only detect when we don't already have a language
        detectSubtitleLanguage(translatedSubtitles, 'translated');
      }
    }
  }, [translatedSubtitles, subtitleSource, translatedLanguage]);

  // Handle model modal
  const openModelModal = () => setIsModelModalOpen(true);
  const closeModelModal = () => setIsModelModalOpen(false);

  // Listen for language detection events
  useEffect(() => {
    const handleDetectionStatus = (event) => {
      const { source } = event.detail;
      if (source === 'original') {
        setIsDetectingOriginal(true);
      } else if (source === 'translated') {
        setIsDetectingTranslated(true);
      }
    };

    const handleDetectionComplete = (event) => {
      const { result, source } = event.detail;
  
      if (source === 'original') {
        setIsDetectingOriginal(false);
        setOriginalLanguage(result);
        // keep stable ref so UI doesn't flash when user switches pills
        lastOriginalLanguageRef.current = result;
  
        // Always call the callback when language is detected, regardless of current selection
        // This ensures modals update their recommended sections
        if (onLanguageDetected) {
          onLanguageDetected(source, result);
        }
      } else if (source === 'translated') {
        setIsDetectingTranslated(false);
        setTranslatedLanguage(result);
        // keep stable ref so UI doesn't flash when user switches pills
        lastTranslatedLanguageRef.current = result;
  
        // Always call the callback when language is detected, regardless of current selection
        // This ensures modals update their recommended sections
        if (onLanguageDetected) {
          onLanguageDetected(source, result);
        }
      }
    };

    const handleDetectionError = (event) => {
      const { source } = event.detail;
      if (source === 'original') {
        setIsDetectingOriginal(false);
      } else if (source === 'translated') {
        setIsDetectingTranslated(false);
      }
    };

    // Listen for translation complete event to trigger language detection
    const handleTranslationComplete = () => {

      // If the user has selected translated subtitles, re-detect the language
      if (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0) {

        setTranslatedLanguage(null); // Reset the language
        detectSubtitleLanguage(translatedSubtitles, 'translated');
      }
    };

    // Listen for translation reset event to clear translated language
    const handleTranslationReset = () => {
      // Just reset the translated language state, don't interfere with subtitle source
      setTranslatedLanguage(null);

      // Don't automatically switch subtitle source - let user control this manually
      // This prevents interference with the translation reset process
    };

    // Add event listeners
    window.addEventListener('language-detection-status', handleDetectionStatus);
    window.addEventListener('language-detection-complete', handleDetectionComplete);
    window.addEventListener('language-detection-error', handleDetectionError);
    window.addEventListener('translation-complete', handleTranslationComplete);
    window.addEventListener('translation-reset', handleTranslationReset);

    // Clean up event listeners
    return () => {
      window.removeEventListener('language-detection-status', handleDetectionStatus);
      window.removeEventListener('language-detection-complete', handleDetectionComplete);
      window.removeEventListener('language-detection-error', handleDetectionError);
      window.removeEventListener('translation-complete', handleTranslationComplete);
      window.removeEventListener('translation-reset', handleTranslationReset);
    };
  }, [subtitleSource, onLanguageDetected, translatedSubtitles, t, originalLanguage, setOriginalLanguage, setSubtitleSource, setTranslatedLanguage]);

  // Ensure detected languages are cleared when subtitles become unavailable
  useEffect(() => {
    // If translated subtitles become unavailable, clear any detected translated language
    if (!hasTranslatedSubtitles && translatedLanguage) {
      try {
        setTranslatedLanguage(null);
        lastTranslatedLanguageRef.current = null;
      } catch (e) {
        // swallow errors to avoid breaking UI
      }
    }
  
    // If original subtitles become unavailable, clear any detected original language
    if (!hasOriginalSubtitles && originalLanguage) {
      try {
        setOriginalLanguage(null);
        lastOriginalLanguageRef.current = null;
      } catch (e) {
        // swallow errors to avoid breaking UI
      }
    }
  }, [hasTranslatedSubtitles, hasOriginalSubtitles, translatedLanguage, originalLanguage, setTranslatedLanguage, setOriginalLanguage]);

  // Auto-select Chatterbox language based on detected subtitle language
  useEffect(() => {
    if (narrationMethod !== 'chatterbox') return;
    if (userHasManuallySelectedChatterboxLanguage) return;

    const supported = [
      'ar','da','de','el','en','es','fi','fr','he','hi','it','ja','ko','ms','nl','no','pl','pt','ru','sv','sw','tr','zh'
    ];

    const currentLanguageObj = subtitleSource === 'translated' ? translatedLanguage : originalLanguage;
    if (!currentLanguageObj) return;

    const candidates = (currentLanguageObj.isMultiLanguage && Array.isArray(currentLanguageObj.secondaryLanguages) && currentLanguageObj.secondaryLanguages.length > 0)
      ? [currentLanguageObj.languageCode, ...currentLanguageObj.secondaryLanguages]
      : [currentLanguageObj.languageCode];

    const normalized = candidates.map(c => (c || '').toLowerCase());
    const match = normalized.find(code => supported.includes(code));
    const next = match || 'en';

    if (next && next !== chatterboxLanguage) {
      setChatterboxLanguage(next);
      try { localStorage.setItem('chatterbox_language', next); } catch {}
    }
  }, [narrationMethod, subtitleSource, originalLanguage, translatedLanguage, userHasManuallySelectedChatterboxLanguage, chatterboxLanguage, setChatterboxLanguage]);

  // Dispatch toast notifications for model errors
  useEffect(() => {
    if (modelError) {
      showErrorToast(modelError);
    }
  }, [modelError]);

  // We're using an inline function for the button click handler

  // Handle model selection
  const handleModelSelect = (modelId) => {
    // Close the modal immediately
    setIsModelModalOpen(false);

    if (narrationMethod === 'chatterbox') {
      // In Chatterbox mode, the modal is for language selection
      const lang = (modelId || 'en').toLowerCase();
      setChatterboxLanguage(lang);
      setUserHasManuallySelectedChatterboxLanguage(true);
      try {
        localStorage.setItem('chatterbox_language', lang);
      } catch (error) {
        console.error('Error saving chatterbox language:', error);
      }
      return;
    }

    // Otherwise: Set the selected model (F5/Gemini)
    setSelectedModel(modelId);

    // Mark that user has manually selected a model
    setUserHasManuallySelectedModel(true);

    // Call the callback with the updated model
    if (onLanguageDetected) {
      const currentLanguage = subtitleSource === 'original' ? originalLanguage : translatedLanguage;
      if (currentLanguage) {
        onLanguageDetected(subtitleSource, currentLanguage, modelId);
      }
    }
  };

  // We no longer need the handleModelChange function as we're using the new dropdown

  // Handle subtitle source change
  const handleSourceChange = async (source) => {
    // Only proceed if the source is different or we don't have language info yet
    if (source !== subtitleSource ||
        (source === 'original' && !originalLanguage) ||
        (source === 'translated' && !translatedLanguage)) {

      setSubtitleSource(source);
      setModelError(null); // Clear any previous errors

      // Reset the manual selection flag when switching subtitle sources
      // This allows automatic model selection for the new source
      setUserHasManuallySelectedModel(false);

      // Detect language for the selected source
      if (source === 'original' && originalSubtitles && originalSubtitles.length > 0) {
        if (!originalLanguage) {
          // Only detect if we don't already have the language
          detectSubtitleLanguage(originalSubtitles, 'original');
        } else if (onLanguageDetected) {
          // We already have the language, just call the callback
          onLanguageDetected('original', originalLanguage);
        }
      } else if (source === 'translated' && translatedSubtitles && translatedSubtitles.length > 0) {
        if (!translatedLanguage) {
          // Only detect if we don't already have the language
          detectSubtitleLanguage(translatedSubtitles, 'translated');
        } else if (onLanguageDetected) {
          // We already have the language, just call the callback
          onLanguageDetected('translated', translatedLanguage);
        }
      }
    }
  };

  // Helper to render language badges
  const renderLanguageBadge = (language) => {
    if (!language) return null;

    // If it's a multi-language text, show badges for all detected languages
    if (language.isMultiLanguage && Array.isArray(language.secondaryLanguages) && language.secondaryLanguages.length > 0) {
      const allLangs = [language.languageCode, ...language.secondaryLanguages].filter(Boolean);
      return (
        <div className="language-badge-container">
          {allLangs.map((langCode, index) => (
            <span key={index} className="language-badge multi">
              {String(langCode).toUpperCase()}
            </span>
          ))}
        </div>
      );
    }

    // Otherwise, just show the primary language
    return (
      <span className="language-badge">
        {language.languageCode.toUpperCase()}
      </span>
    );
  };

  // Helper to render refresh button when no language is detected
  const renderRefreshButton = (source, subtitles, isDetecting) => {
    if (!subtitles || subtitles.length === 0 || isDetecting) return null;

    const handleRefresh = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Trigger language detection for the specific source
      if (source === 'original') {
        setOriginalLanguage(null);
        detectSubtitleLanguage(originalSubtitles, 'original');
      } else if (source === 'translated') {
        setTranslatedLanguage(null);
        detectSubtitleLanguage(translatedSubtitles, 'translated');
      }
    };

    return (
      <button
        className="language-refresh-button"
        onClick={handleRefresh}
        title={t('narration.detectLanguage', 'Detect language')}
        type="button"
      >
        <span className="material-symbols-rounded" style={{ fontSize: '12px' }}>refresh</span>
      </button>
    );
  };

  // Helper to render manual language selection button
  const renderManualButton = (source, subtitles, isHovered) => {
    if (!subtitles || subtitles.length === 0 || !isHovered) return null;

    const handleManualSelect = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openManualLanguageModal(source);
    };

    return (
      <button
        className="language-manual-button"
        onClick={handleManualSelect}
        title={t('narration.manualLanguageSelection', 'Manual language selection')}
        type="button"
      >
        {t('narration.manual', 'manual')}
      </button>
    );
  };

  // Helper to render model languages in dropdown
  const renderModelLanguages = (model) => {
    // If model has multiple languages
    if (Array.isArray(model.languages) && model.languages.length > 0) {
      return `(${model.languages.map(lang => lang.toUpperCase()).join(', ')})`;
    }
    // If model has a single language
    else if (model.language) {
      return `(${model.language.toUpperCase()})`;
    }
    // If no language information is available
    return '';
  };
  
  // Use last-detected refs to avoid transient null flashes when switching sources
  const displayedOriginalLanguage = originalLanguage || lastOriginalLanguageRef.current;
  const displayedTranslatedLanguage = translatedLanguage || lastTranslatedLanguageRef.current;
  
  return (
    <>
      <div className="narration-row subtitle-source-row animated-row">
        <div className="row-label">
          <label>{t('narration.subtitleSource', 'Subtitle Source')}:</label>
        </div>
        <div className="row-content">
          <div className="subtitle-selection-container">
            <div className="radio-pill-group">
              <div className="radio-pill">
                <input
                  type="radio"
                  id="source-original"
                  name="subtitle-source"
                  value="original"
                  checked={subtitleSource === 'original'}
                  onChange={() => handleSourceChange('original')}
                  disabled={isGenerating}
                />
                <label
                  htmlFor="source-original"
                  onMouseEnter={() => setHoveredPill('original')}
                  onMouseLeave={() => setHoveredPill(null)}
                  className={(originalLanguage || (!originalLanguage && originalSubtitles && originalSubtitles.length > 0 && !isDetectingOriginal) || hoveredPill === 'original') ? 'has-additional' : ''}
                >
                  {isDetectingOriginal ? (
                    <span className="loading-animation">
                      <LoadingIndicator
                        theme="dark"
                        showContainer={false}
                        size={18}
                        className="language-detection-loading"
                      />
                      {t('narration.detectingLanguage', 'Detecting language...')}
                    </span>
                  ) : (
                    <>
                      {t('narration.originalSubtitles', 'Original Subtitles')}
                      {originalLanguage && renderLanguageBadge(originalLanguage)}
                      {!originalLanguage && renderRefreshButton('original', originalSubtitles, isDetectingOriginal)}
                      {renderManualButton('original', originalSubtitles, hoveredPill === 'original')}
                    </>
                  )}
                </label>
              </div>
              <div className="radio-pill">
                <input
                  type="radio"
                  id="source-translated"
                  name="subtitle-source"
                  value="translated"
                  checked={subtitleSource === 'translated'}
                  onChange={() => handleSourceChange('translated')}
                  disabled={isGenerating || !hasTranslatedSubtitles}
                />
                <label
                  htmlFor="source-translated"
                  onMouseEnter={() => setHoveredPill('translated')}
                  onMouseLeave={() => setHoveredPill(null)}
                  className={(translatedLanguage || (!translatedLanguage && hasTranslatedSubtitles && !isDetectingTranslated) || hoveredPill === 'translated') ? 'has-additional' : ''}
                >
                  {isDetectingTranslated ? (
                    <span className="loading-animation">
                      <LoadingIndicator
                        theme="dark"
                        showContainer={false}
                        size={18}
                        className="language-detection-loading"
                      />
                      {t('narration.detectingLanguage', 'Detecting language...')}
                    </span>
                  ) : (
                    <>
                      {t('narration.translatedSubtitles', 'Translated Subtitles')}
                      {translatedLanguage && renderLanguageBadge(translatedLanguage)}
                      {!translatedLanguage && hasTranslatedSubtitles && renderRefreshButton('translated', translatedSubtitles, isDetectingTranslated)}
                      {hasTranslatedSubtitles && renderManualButton('translated', translatedSubtitles, hoveredPill === 'translated')}
                      {!hasTranslatedSubtitles && (
                        <span className="unavailable-indicator">
                          {t('narration.unavailable', '(unavailable)')}
                        </span>
                      )}
                    </>
                  )}
                </label>
              </div>
            </div>

            {/* Model information and error messages */}
            {isCheckingModel && (
              <div className="model-checking">
                <span className="spinner-circle"></span>
                <span>{t('narration.checkingModelAvailability', 'Checking model availability...')}</span>
              </div>
            )}

            {/* Show dropdown area: for Chatterbox this is a Language selector, others keep Model selector */}
            {narrationMethod !== 'edge-tts' && narrationMethod !== 'gtts' && (
              narrationMethod === 'chatterbox' ? (
                <div
                  className="model-dropdown-container narration-model-dropdown-container chatterbox-pill"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isGenerating) openModelModal();
                  }}
                  role="button"
                  tabIndex={0}
                  aria-disabled={isGenerating}
                  title={t('narration.selectLanguage', 'Select language')}
                >
                  <span className="model-dropdown-label">{t('narration.language', 'Language')}:</span>
                  <span className="model-dropdown-selected">
                    <span className="model-name">{(chatterboxLanguage || 'en').toUpperCase()}</span>
                  </span>
                  <span className="material-symbols-rounded dropdown-icon" style={{ fontSize: '14px' }}>expand_more</span>
                </div>
              ) : (
                <div className="model-dropdown-container narration-model-dropdown-container">
                  <button
                    className="model-dropdown-btn narration-model-dropdown-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openModelModal();
                    }}
                    title={t('narration.selectNarrationModel', 'Select narration model')}
                    disabled={isGenerating}
                  >
                    <span className="model-dropdown-label">{t('narration.narrationModel', 'Model')}:</span>
                    <span className="model-dropdown-selected">
                      <span className="model-name">{selectedModel}</span>
                    </span>
                    <span className="material-symbols-rounded dropdown-icon" style={{ fontSize: '14px' }}>expand_more</span>
                  </button>
                </div>
              )
            )}
          </div>
        </div>
      </div>

      {/* Subtitle Grouping as a separate row */}
      <div className="narration-row subtitle-grouping-row animated-row">
        <div className="row-label">
          <label>{t('narration.subtitleGrouping', 'Subtitle Grouping')}:</label>
        </div>
        <div className="row-content">
          <div className="subtitle-grouping-container" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '20px' }}>
            {/* Grouping Intensity Dropdown */}
            <div
              className="grouping-intensity-container"
            >
              <label htmlFor="grouping-intensity" className="grouping-intensity-label">
                {t('narration.groupingIntensity', 'Grouping Intensity')}:
              </label>
              <CustomDropdown
                value={groupingIntensity}
                onChange={(value) => setGroupingIntensity(value)}
                disabled={isGenerating || !subtitleSource || isGroupingSubtitles || !hasSubtitles || useGroupedSubtitles}
                options={[
                  { value: 'minimal', label: t('narration.intensityMinimal', 'Minimal') },
                  { value: 'light', label: t('narration.intensityLight', 'Light') },
                  { value: 'balanced', label: t('narration.intensityBalanced', 'Balanced') },
                  { value: 'moderate', label: t('narration.intensityModerate', 'Moderate') },
                  { value: 'enhanced', label: t('narration.intensityEnhanced', 'Enhanced') },
                  { value: 'aggressive', label: t('narration.intensityAggressive', 'Aggressive') }
                ]}
                placeholder={t('narration.selectIntensity', 'Select Intensity')}
              />
            </div>

            {/* Material Web Switch and Grouping Info */}
            <div className="grouping-controls-wrapper" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="material-switch-container">
                <MaterialSwitch
                  id="subtitle-grouping"
                  checked={useGroupedSubtitles}
                  onChange={(e) => handleGroupingToggle(e.target.checked)}
                  disabled={isGenerating || !subtitleSource || isGroupingSubtitles || !hasSubtitles}
                  ariaLabel={t('narration.groupSubtitlesShort', 'Group subtitles')}
                  icons={true}
                />
                <label htmlFor="subtitle-grouping" className="material-switch-label">
                  <HelpIcon title={t('narration.groupSubtitles', 'Smartly group subtitles into fuller sentences for narration')} />
                  {isGroupingSubtitles && (
                    <span className="loading-animation" style={{ marginLeft: '10px', display: 'inline-flex', alignItems: 'center' }}>
                      <span className="spinner-circle" style={{ width: '14px', height: '14px' }}></span>
                      <span style={{ marginLeft: '5px' }}>{t('narration.groupingSubtitles', 'Grouping...')}</span>
                    </span>
                  )}
                </label>
              </div>

              {/* Show comparison button when grouped subtitles are available */}
              {useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0 && (
                <div className="grouping-info-container">
                  <button
                    className="pill-button view-grouping-button"
                    onClick={openModal}
                  >
                    <span className="material-symbols-rounded info-icon" style={{ fontSize: '16px' }}>info</span>
                    {t('narration.viewGrouping', 'View Grouping')}
                  </button>
                  <span className="grouping-stats">
                    {t('narration.groupedSubtitlesCount', 'Grouped {{original}} subtitles into {{grouped}} sentences', {
                      original: originalSubtitles?.length || 0,
                      grouped: groupedSubtitles?.length || 0
                    })}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

      {/* Compute models for modal: override with Chatterbox's multilingual support when in chatterbox mode */}
      {(() => {
        // Chatterbox supported languages (must match backend SUPPORTED_LANGUAGES)
        const chatterboxSupportedLangs = [
          'ar','da','de','el','en','es','fi','fr','he','hi','it','ja','ko','ms','nl','no','pl','pt','ru','sv','sw','tr','zh'
        ];
        const chatterboxModels = [
          { id: 'chatterbox-multilingual-tts', languages: chatterboxSupportedLangs }
        ];
        // Expose computed array on a scoped variable for the JSX below
        window.__modelsForNarrationModal = (narrationMethod === 'chatterbox') ? chatterboxModels : availableModels;
        return null;
      })()}

      </div>

      {/* Model Selection Modal */}
      <ModelSelectionModal
        isOpen={isModelModalOpen}
        onClose={closeModelModal}
        availableModels={window.__modelsForNarrationModal || availableModels}
        isLoadingModels={isLoadingModels}
        selectedModel={selectedModel}
        onModelSelect={handleModelSelect}
        subtitleSource={subtitleSource}
        originalLanguage={originalLanguage}
        translatedLanguage={translatedLanguage}
        renderModelLanguages={renderModelLanguages}
        isChatterboxMode={narrationMethod === 'chatterbox'}
      />

      {/* Subtitle Grouping Comparison Modal */}
      <SubtitleGroupingModal
        open={isModalOpen}
        onClose={closeModal}
        originalSubtitles={subtitleSource === 'translated' && hasTranslatedSubtitles ? translatedSubtitles : originalSubtitles}
        groupedSubtitles={groupedSubtitles}
        subtitleSource={subtitleSource}
      />

      {/* Manual Language Selection Modal */}
      <ManualLanguageSelectionModal
        isOpen={isManualLanguageModalOpen}
        onClose={closeManualLanguageModal}
        onSave={handleManualLanguageSave}
        initialLanguages={
          manualLanguageSource === 'original' && originalLanguage
            ? [originalLanguage.languageCode, ...(originalLanguage.secondaryLanguages || [])]
            : manualLanguageSource === 'translated' && translatedLanguage
            ? [translatedLanguage.languageCode, ...(translatedLanguage.secondaryLanguages || [])]
            : []
        }
        subtitleSource={manualLanguageSource}
      />
    </>
  );
};

export default SubtitleSourceSelection;
