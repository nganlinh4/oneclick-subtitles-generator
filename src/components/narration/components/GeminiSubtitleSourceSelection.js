import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import MaterialSwitch from '../../common/MaterialSwitch';
import CustomDropdown from '../../common/CustomDropdown';
import '../../../styles/common/material-switch.css';
import { detectSubtitleLanguage } from '../../../services/gemini/languageDetectionService';
import '../../../styles/narration/subtitleSourceSelectionMaterial.css';
import '../../../styles/narration/languageBadges.css';
import ManualLanguageSelectionModal from './ManualLanguageSelectionModal';
import SubtitleGroupingModal from './SubtitleGroupingModal';
import HelpIcon from '../../common/HelpIcon';

/**
 * Simplified subtitle source selection component for Gemini narration
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
 * @param {Array} props.originalSubtitles - Original subtitles
 * @param {Array} props.groupedSubtitles - Grouped subtitles
 * @param {string} props.groupingIntensity - Intensity level for subtitle grouping
 * @param {Function} props.setGroupingIntensity - Function to set grouping intensity
 * @returns {JSX.Element} - Rendered component
 */
const GeminiSubtitleSourceSelection = ({
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
  setGroupingIntensity = () => {}
}) => {
  const { t } = useTranslation();

  // State for language detection and modal
  const [isDetectingOriginal, setIsDetectingOriginal] = useState(false);
  const [isDetectingTranslated, setIsDetectingTranslated] = useState(false);
  // State for manual language selection modal
  const [isManualLanguageModalOpen, setIsManualLanguageModalOpen] = useState(false);
  const [manualLanguageSource, setManualLanguageSource] = useState(null);

  // Hover state for showing manual button
  const [hoveredPill, setHoveredPill] = useState(null);

  // Open/close manual language modal
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

    if (!languages || languages.length === 0) {
      if (manualLanguageSource === 'original') {
        setOriginalLanguage(null);
      } else if (manualLanguageSource === 'translated') {
        setTranslatedLanguage(null);
      }
      return;
    }

    const manualLanguage = {
      languageCode: languages[0] || 'unknown',
      secondaryLanguages: languages.length > 1 ? languages.slice(1) : [],
      isMultiLanguage: languages.length > 1,
      isManualSelection: true,
      confidence: 1.0
    };

    if (manualLanguageSource === 'original') {
      setOriginalLanguage(manualLanguage);
    } else if (manualLanguageSource === 'translated') {
      setTranslatedLanguage(manualLanguage);
    }

    if (onLanguageDetected) {
      onLanguageDetected(manualLanguageSource, manualLanguage);
    }
  };

  const [isModalOpen, setIsModalOpen] = useState(false);

  // Function to handle subtitle grouping toggle
  const handleGroupingToggle = (checked) => {
    if (checked) {
      // If turning on, only clear existing grouped subtitles if we want to force re-grouping
      // Check if we already have grouped subtitles - if so, keep them
      if (!groupedSubtitles || groupedSubtitles.length === 0) {
        // No existing grouped subtitles, clear to force re-request to Gemini
        if (typeof window.setGroupedSubtitles === 'function') {
          window.setGroupedSubtitles(null);
        }
        window.groupedSubtitles = null;
      }

      // Clear the user disabled flag since they're turning it back on
      try {
        localStorage.removeItem('user_disabled_grouping');
      } catch (error) {
        console.error('Error clearing user disabled grouping flag:', error);
      }

      // Update the state - the useGeminiNarration hook will handle the grouping logic
      setUseGroupedSubtitles(true);
    } else {
      // If turning off, clear the grouping data and update the state
      setUseGroupedSubtitles(false);

      // Clear the grouped subtitles data
      if (typeof window.setGroupedSubtitles === 'function') {
        window.setGroupedSubtitles(null);
      }
      window.groupedSubtitles = null;

      // Set flag to prevent auto-loading from cache
      try {
        localStorage.setItem('user_disabled_grouping', 'true');
      } catch (error) {
        console.error('Error setting user disabled grouping flag:', error);
      }
    }
  };

  // We don't need to define onGroupedSubtitlesGenerated here
  // It's passed as a prop from the parent component

  // Functions to handle modal
  const openModal = () => setIsModalOpen(true);
  const closeModal = () => setIsModalOpen(false);

  // Check if subtitles are available
  const hasTranslatedSubtitles = translatedSubtitles && translatedSubtitles.length > 0;
  const hasOriginalSubtitles = originalSubtitles && originalSubtitles.length > 0;
  const hasSubtitles = hasOriginalSubtitles || hasTranslatedSubtitles;

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

        // Always call the callback when language is detected, regardless of current selection
        // This ensures modals update their recommended sections
        if (onLanguageDetected) {
          onLanguageDetected(source, result);
        }
      } else if (source === 'translated') {
        setIsDetectingTranslated(false);
        setTranslatedLanguage(result);

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

    // Add event listeners
    window.addEventListener('language-detection-status', handleDetectionStatus);
    window.addEventListener('language-detection-complete', handleDetectionComplete);
    window.addEventListener('language-detection-error', handleDetectionError);

    // Clean up event listeners
    return () => {
      window.removeEventListener('language-detection-status', handleDetectionStatus);
      window.removeEventListener('language-detection-complete', handleDetectionComplete);
      window.removeEventListener('language-detection-error', handleDetectionError);
    };
  }, [subtitleSource, onLanguageDetected, setOriginalLanguage, setTranslatedLanguage]);

  // Ensure detected languages are cleared when subtitles become unavailable
  useEffect(() => {
    // If translated subtitles become unavailable, clear any detected translated language
    if (!hasTranslatedSubtitles && translatedLanguage) {
      try {
        setTranslatedLanguage(null);
      } catch (e) {
        // swallow errors to avoid breaking UI
      }
    }

    // If original subtitles become unavailable, clear any detected original language
    if (!hasOriginalSubtitles && originalLanguage) {
      try {
        setOriginalLanguage(null);
      } catch (e) {
        // swallow errors to avoid breaking UI
      }
    }
  }, [hasTranslatedSubtitles, hasOriginalSubtitles, translatedLanguage, originalLanguage, setTranslatedLanguage, setOriginalLanguage]);

  // Handle subtitle source change
  const handleSourceChange = async (source) => {
    // Only proceed if the source is different or we don't have language info yet
    if (source !== subtitleSource ||
        (source === 'original' && !originalLanguage) ||
        (source === 'translated' && !translatedLanguage)) {

      setSubtitleSource(source);

      // Detect language for the selected source
      if (source === 'original' && originalSubtitles && originalSubtitles.length > 0) {
        if (!originalLanguage) {
          // Only detect if we don't already have the language
          detectSubtitleLanguage(originalSubtitles, 'original');
        } else if (onLanguageDetected) {
          // We already have the language
          onLanguageDetected('original', originalLanguage);
        }
      } else if (source === 'translated' && translatedSubtitles && translatedSubtitles.length > 0) {
        if (!translatedLanguage) {
          // Only detect if we don't already have the language
          detectSubtitleLanguage(translatedSubtitles, 'translated');
        } else if (onLanguageDetected) {
          // We already have the language
          onLanguageDetected('translated', translatedLanguage);
        }
      }
    }
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
        <span className="material-symbols-rounded" style={{ fontSize: 12 }}>refresh</span>
      </button>
    );
  };

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
                      <span className="spinner-circle"></span>
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
                      <span className="spinner-circle"></span>
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
          </div>
        </div>
      </div>

      {/* Subtitle Grouping as a separate row */}
      <div className="narration-row subtitle-grouping-row animated-row">
        <div className="row-label">
          <label>{t('narration.subtitleGrouping', 'Subtitle Grouping')}:</label>

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

      {/* Subtitle Grouping Comparison Modal */}
      <SubtitleGroupingModal
        open={isModalOpen}
        onClose={closeModal}
        originalSubtitles={subtitleSource === 'translated' && hasTranslatedSubtitles ? translatedSubtitles : originalSubtitles}
        groupedSubtitles={groupedSubtitles}
        subtitleSource={subtitleSource}
      />
    </>
  );
};

export default GeminiSubtitleSourceSelection;
