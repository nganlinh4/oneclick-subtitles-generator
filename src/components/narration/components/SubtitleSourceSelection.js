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
import useSubtitleLanguageDetection from '../hooks/useSubtitleLanguageDetection';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { getSpeechStatus } from '../../../platform/speechService';
import { handleGroupingToggle as handleGroupingToggleHandler } from '../utils/subtitleGroupingHandlers';
import {
  handleSourceChange as handleSourceChangeHandler,
  handleManualLanguageSave as handleManualLanguageSaveHandler
} from '../utils/subtitleSourceHandlers';
import {
  renderLanguageBadge,
  renderRefreshButton as renderRefreshButtonHelper,
  renderManualButton as renderManualButtonHelper,
  renderModelLanguages
} from '../utils/subtitleLanguageHelpers';

// Chatterbox supported languages (must match backend SUPPORTED_LANGUAGES)
const CHATTERBOX_SUPPORTED_LANGS = [
  'ar','da','de','el','en','es','fi','fr','he','hi','it','ja','ko','ms','nl','no','pl','pt','ru','sv','sw','tr','zh'
];

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
  const handleGroupingToggle = (checked) => handleGroupingToggleHandler(checked, {
    groupedSubtitles,
    subtitleSource,
    hasTranslatedSubtitles,
    translatedSubtitles,
    originalSubtitles,
    translatedLanguage,
    originalLanguage,
    groupingIntensity,
    setUseGroupedSubtitles
  });

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
  const handleManualLanguageSave = (languages) => handleManualLanguageSaveHandler(languages, {
    manualLanguageSource,
    setOriginalLanguage,
    setTranslatedLanguage,
    onLanguageDetected
  });

  // State for model selection
  const [modelError, setModelError] = useState(null);
  const [isCheckingModel] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isModelModalOpen, setIsModelModalOpen] = useState(false);
  const [, setUserHasManuallySelectedModel] = useState(false);
  const [userHasManuallySelectedChatterboxLanguage, setUserHasManuallySelectedChatterboxLanguage] = useState(false);

  // Keep a stable reference to the last detected languages so a transient null
  // in state (during quick UI switches) doesn't show the refresh button briefly.
  const lastOriginalLanguageRef = React.useRef(null);
  const lastTranslatedLanguageRef = React.useRef(null);

  // Wire up language-detection window events and detection-in-progress state
  const { isDetectingOriginal, isDetectingTranslated } = useSubtitleLanguageDetection({
    subtitleSource,
    translatedSubtitles,
    setOriginalLanguage,
    setTranslatedLanguage,
    onLanguageDetected,
    lastOriginalLanguageRef,
    lastTranslatedLanguageRef
  });

  // Load available models
  useEffect(() => {
    const loadModels = async () => {
      setIsLoadingModels(true);
      try {
        if (isDesktopRuntime()) {
          const status = await getSpeechStatus();
          const f5 = status.backends.find((backend) => backend.backend === 'f5Tts');
          setAvailableModels(f5?.installed
            ? [{ id: 'f5tts-v1-base', languages: CHATTERBOX_SUPPORTED_LANGS }]
            : []);
          return;
        }
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

    const currentLanguageObj = subtitleSource === 'translated' ? translatedLanguage : originalLanguage;
    if (!currentLanguageObj) return;

    const candidates = (currentLanguageObj.isMultiLanguage && Array.isArray(currentLanguageObj.secondaryLanguages) && currentLanguageObj.secondaryLanguages.length > 0)
      ? [currentLanguageObj.languageCode, ...currentLanguageObj.secondaryLanguages]
      : [currentLanguageObj.languageCode];

    const normalized = candidates.map(c => (c || '').toLowerCase());
    const match = normalized.find(code => CHATTERBOX_SUPPORTED_LANGS.includes(code));
    const next = match || 'en';

    if (next && next !== chatterboxLanguage) {
      setChatterboxLanguage(next);
      try { localStorage.setItem('chatterbox_language', next); } catch { /* Storage is best-effort. */ }
    }
  }, [narrationMethod, subtitleSource, originalLanguage, translatedLanguage, userHasManuallySelectedChatterboxLanguage, chatterboxLanguage, setChatterboxLanguage]);

  // Dispatch toast notifications for model errors
  useEffect(() => {
    if (modelError) {
      showErrorToast(modelError);
    }
  }, [modelError]);

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

  // Handle subtitle source change
  const handleSourceChange = (source) => handleSourceChangeHandler(source, {
    subtitleSource,
    originalLanguage,
    translatedLanguage,
    originalSubtitles,
    translatedSubtitles,
    setSubtitleSource,
    setModelError,
    setUserHasManuallySelectedModel,
    onLanguageDetected
  });

  // Render helpers (thin wrappers that supply `t`/state/setters to pure helpers)
  const renderRefreshButton = (source, subtitles, isDetecting) =>
    renderRefreshButtonHelper(source, subtitles, isDetecting, {
      t,
      originalSubtitles,
      translatedSubtitles,
      setOriginalLanguage,
      setTranslatedLanguage
    });

  const renderManualButton = (source, subtitles, isHovered) =>
    renderManualButtonHelper(source, subtitles, isHovered, {
      t,
      openManualLanguageModal
    });

  // Models shown in the selection modal: Chatterbox advertises its own multilingual
  // model, everything else uses the dynamically loaded available models.
  const modelsForNarrationModal = narrationMethod === 'chatterbox'
    ? [{ id: 'chatterbox-multilingual-tts', languages: CHATTERBOX_SUPPORTED_LANGS }]
    : availableModels;

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
      </div>

      {/* Model Selection Modal */}
      <ModelSelectionModal
        isOpen={isModelModalOpen}
        onClose={closeModelModal}
        availableModels={modelsForNarrationModal}
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
