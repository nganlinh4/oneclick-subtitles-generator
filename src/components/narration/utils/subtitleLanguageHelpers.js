import { detectSubtitleLanguage } from '../../../services/gemini/languageDetectionService';

/**
 * Render language badges for a detected language.
 * Shows multiple badges for multi-language text, otherwise a single primary badge.
 *
 * @param {Object} language - Detected language info
 * @returns {JSX.Element|null}
 */
export const renderLanguageBadge = (language) => {
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

/**
 * Render the refresh button shown when no language is detected for a source.
 *
 * @param {string} source - 'original' | 'translated'
 * @param {Array} subtitles - Subtitles for the source
 * @param {boolean} isDetecting - Whether detection is in progress
 * @param {Object} params
 * @param {Function} params.t - Translation function
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Function} params.setOriginalLanguage - Setter for original language
 * @param {Function} params.setTranslatedLanguage - Setter for translated language
 * @returns {JSX.Element|null}
 */
export const renderRefreshButton = (source, subtitles, isDetecting, {
  t,
  originalSubtitles,
  translatedSubtitles,
  setOriginalLanguage,
  setTranslatedLanguage
}) => {
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

/**
 * Render the manual language selection button (visible on hover).
 *
 * @param {string} source - 'original' | 'translated'
 * @param {Array} subtitles - Subtitles for the source
 * @param {boolean} isHovered - Whether the pill is hovered
 * @param {Object} params
 * @param {Function} params.t - Translation function
 * @param {Function} params.openManualLanguageModal - Opens the manual language modal
 * @returns {JSX.Element|null}
 */
export const renderManualButton = (source, subtitles, isHovered, {
  t,
  openManualLanguageModal
}) => {
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

/**
 * Render the languages a model supports, formatted for the dropdown.
 *
 * @param {Object} model - Model descriptor
 * @returns {string}
 */
export const renderModelLanguages = (model) => {
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
