import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import CloseButton from '../../common/CloseButton';
import LoadingIndicator from '../../common/LoadingIndicator';
import '../../../styles/narration/narrationModelDropdown.css';

/**
 * Model Selection Modal Component
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the modal is open
 * @param {Function} props.onClose - Function called when modal is closed
 * @param {Array} props.availableModels - Array of available models
 * @param {boolean} props.isLoadingModels - Whether models are being loaded
 * @param {string} props.selectedModel - Currently selected model
 * @param {Function} props.onModelSelect - Function called when a model is selected
 * @param {string} props.subtitleSource - Current subtitle source ('original' or 'translated')
 * @param {Object} props.originalLanguage - Original language object
 * @param {Object} props.translatedLanguage - Translated language object
 * @param {Function} props.renderModelLanguages - Function to render model languages
 * @param {boolean} props.isChatterboxMode - If true, render Chatterbox-specific modal content
 * @returns {JSX.Element|null} - Rendered component or null if not open
 */
const ModelSelectionModal = ({
  isOpen,
  onClose,
  availableModels,
  isLoadingModels,
  selectedModel,
  onModelSelect,
  subtitleSource,
  originalLanguage,
  translatedLanguage,
  renderModelLanguages,
  isChatterboxMode = false,
}) => {
  const { t, i18n } = useTranslation();
  const modalRef = useRef(null);

  // Handle ESC key to close
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
    }

    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isOpen, onClose]);

  // Focus management
  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
    }
  }, [isOpen]);

  // Handle click outside to close
  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleModelSelect = (modelId) => {
    onModelSelect(modelId);
    onClose();
  };

  if (!isOpen) return null;

  // Use ReactDOM.createPortal to render the modal outside the VideoRenderingSection's stacking context
  return ReactDOM.createPortal(
    <div className="model-selection-modal-overlay" onClick={handleOverlayClick}>
      <div
        className="model-selection-modal"
        ref={modalRef}
        tabIndex="-1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="model-selection-modal-header">
          <h2>
            {isChatterboxMode
              ? t('narration.selectLanguage', 'Select language')
              : t('narration.selectNarrationModel', 'Select narration model')}
          </h2>
          <CloseButton onClick={onClose} variant="modal" size="medium" />
        </div>
        <div className="model-selection-modal-content">
          {isChatterboxMode ? (
            // Chatterbox: show language selector derived from availableModels languages
            (() => {
              const languageSet = new Set();
              (availableModels || []).forEach(m => {
                if (Array.isArray(m.languages)) m.languages.forEach(l => languageSet.add(l));
                if (m.language) languageSet.add(m.language);
              });
              const languages = Array.from(languageSet).sort();
              // Build recommended vs other groups
              const currentLanguageObj = subtitleSource === 'original' ? originalLanguage : translatedLanguage;
              const languagesToCheck = currentLanguageObj && (currentLanguageObj.isMultiLanguage && Array.isArray(currentLanguageObj.secondaryLanguages) && currentLanguageObj.secondaryLanguages.length > 0)
                ? Array.from(new Set([currentLanguageObj.languageCode, ...currentLanguageObj.secondaryLanguages]))
                : (currentLanguageObj ? [currentLanguageObj.languageCode] : []);
              const recommended = languages.filter(l => languagesToCheck.includes(l));
              const others = languages.filter(l => !languagesToCheck.includes(l));

              const tEn = i18n.getFixedT ? i18n.getFixedT('en') : ((k, d) => d || k);
              const getLanguageEnglish = (code) => tEn(`narration.languages.${code}`, code.toUpperCase());
              const getLanguageLocalized = (code) => t(`narration.languages.${code}`, code.toUpperCase());
              const showLocalizedSuffix = !/^en/i.test(i18n?.language || '');
              const sortByEnglishName = (a, b) => getLanguageEnglish(a).localeCompare(getLanguageEnglish(b), 'en', { sensitivity: 'base' });
              const flagFor = (code) => ({
                ar: '🇸🇦', da: '🇩🇰', de: '🇩🇪', el: '🇬🇷', en: '🇺🇸', es: '🇪🇸', fi: '🇫🇮', fr: '🇫🇷',
                he: '🇮🇱', hi: '🇮🇳', it: '🇮🇹', ja: '🇯🇵', ko: '🇰🇷', ms: '🇲🇾', nl: '🇳🇱', no: '🇳🇴',
                pl: '🇵🇱', pt: '🇵🇹', ru: '🇷🇺', sv: '🇸🇪', sw: '🇰🇪', tr: '🇹🇷', zh: '🇨🇳'
              }[code] || '🏳️');

              const Card = ({ lang }) => (
                <div
                  key={lang}
                  className="model-option-card"
                  onClick={() => handleModelSelect(lang)}
                >
                  <div className="model-option-icon" aria-hidden="true"><span className="model-flag">{flagFor(lang)}</span></div>
                  <div className="model-option-info">
                    <div className="model-option-name">{showLocalizedSuffix ? `${getLanguageEnglish(lang)} - ${getLanguageLocalized(lang)}` : getLanguageEnglish(lang)}</div>
                    <div className="model-option-description">{t('narration.chatterboxMultilingual', 'Chatterbox Multilingual')}</div>
                  </div>
                </div>
              );

              return (
                <>
                  <div className="model-selection-explanation">
                    {t('narration.selectLanguageExplanation', 'Choose the target language for Chatterbox Multilingual TTS.')}
                  </div>

                  {recommended.length > 0 && (
                    <div className="model-group">
                      <div className="model-group-label recommended-models-label voice-category-title recommended">
                        {t('narration.recommendedLanguages', 'Recommended Languages')}
                      </div>
                      <div className="model-options-grid">
                        {[...recommended].sort(sortByEnglishName).map((l) => <Card key={l} lang={l} />)}
                      </div>
                    </div>
                  )}

                  <div className="model-group">
                    <div className="model-group-label voice-category-title">
                      {t('narration.otherLanguages', 'Other Languages')}
                    </div>
                    <div className="model-options-grid">
                      {[...others].sort(sortByEnglishName).map((l) => <Card key={l} lang={l} />)}
                    </div>
                  </div>
                </>
              );
            })()
          ) : isLoadingModels ? (
            <div className="loading-animation modal-loading">
              <LoadingIndicator
                theme="dark"
                showContainer={false}
                size={24}
                className="model-loading-indicator"
              />
              <span>{t('narration.loadingModels', 'Loading models...')}</span>
            </div>
          ) : availableModels.length > 0 ? (
            <>
              <div className="model-selection-explanation">
                {t('narration.selectModelExplanation', 'Choose a narration model that supports your subtitle language for the best results.')}
              </div>

              {/* Group 1: Models matching the detected language */}
              <div className="model-group">
                <div className="model-group-label recommended-models-label">
                  {t('narration.matchingLanguageModels', 'Recommended Models')}
                </div>
                <div className="model-options-grid">
                  {availableModels
                    .filter(model => {
                      const currentLanguageObj = subtitleSource === 'original'
                        ? originalLanguage
                        : translatedLanguage;

                      if (!currentLanguageObj) return false;

                      // Get all language codes to check (primary + secondary)
                      const languagesToCheck = currentLanguageObj.isMultiLanguage &&
                        Array.isArray(currentLanguageObj.secondaryLanguages) &&
                        currentLanguageObj.secondaryLanguages.length > 0
                          ? currentLanguageObj.secondaryLanguages // Use all languages if multi-language
                          : [currentLanguageObj.languageCode]; // Just use primary language

                      // Check if model supports any of the detected languages
                      return languagesToCheck.some(langCode =>
                        model.language === langCode ||
                        (Array.isArray(model.languages) && model.languages.includes(langCode))
                      );
                    })
                    .map(model => (
                      <div
                        key={model.id}
                        className={`model-option-card ${model.id === selectedModel ? 'selected' : ''}`}
                        onClick={() => handleModelSelect(model.id)}
                      >
                        <div className="model-option-icon">
                          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>check_circle</span>
                        </div>
                        <div className="model-option-info">
                          <div className="model-option-name">{model.id}</div>
                          <div className="model-option-description">{renderModelLanguages(model)}</div>
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>

              {/* Group 2: All other models */}
              <div className="model-group">
                <div className="model-group-label">
                  {t('narration.otherModels', 'Other Available Models')}
                </div>
                <div className="model-options-grid">
                  {availableModels
                    .filter(model => {
                      const currentLanguageObj = subtitleSource === 'original'
                        ? originalLanguage
                        : translatedLanguage;

                      if (!currentLanguageObj) return true;

                      // Get all language codes to check (primary + secondary)
                      const languagesToCheck = currentLanguageObj.isMultiLanguage &&
                        Array.isArray(currentLanguageObj.secondaryLanguages) &&
                        currentLanguageObj.secondaryLanguages.length > 0
                          ? currentLanguageObj.secondaryLanguages // Use all languages if multi-language
                          : [currentLanguageObj.languageCode]; // Just use primary language

                      // Check if model does NOT support any of the detected languages
                      return !languagesToCheck.some(langCode =>
                        model.language === langCode ||
                        (Array.isArray(model.languages) && model.languages.includes(langCode))
                      );
                    })
                    .map(model => (
                      <div
                        key={model.id}
                        className={`model-option-card ${model.id === selectedModel ? 'selected' : ''}`}
                        onClick={() => handleModelSelect(model.id)}
                      >
                        <div className="model-option-icon">
                          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>settings</span>
                        </div>
                        <div className="model-option-info">
                          <div className="model-option-name">{model.id}</div>
                          <div className="model-option-description">{renderModelLanguages(model)}</div>
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>
            </>
          ) : (
            <div className="no-models-message">
              <div className="model-option-card">
                <div className="model-option-icon">
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>check_circle</span>
                </div>
                <div className="model-option-info">
                  <div className="model-option-name">{selectedModel}</div>
                  <div className="model-option-description">{t('narration.noModelsAvailable', 'No other models available')}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body // Render directly into document.body to escape VideoRenderingSection's stacking context
  );
};

export default ModelSelectionModal;
