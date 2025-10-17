import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Language input fields component
 * @param {Object} props - Component props
 * @param {Array} props.targetLanguages - Array of language objects
 * @param {Function} props.onAddLanguage - Function to add a language
 * @param {Function} props.onRemoveLanguage - Function to remove a language
 * @param {Function} props.onLanguageChange - Function to update a language
 * @param {boolean} props.disabled - Whether the inputs are disabled
 * @returns {JSX.Element} - Rendered component
 */
const LanguageInputs = ({
  targetLanguages,
  onAddLanguage,
  onRemoveLanguage,
  onLanguageChange,
  disabled = false
}) => {
  const { t } = useTranslation();

  return (
    <div className="translation-row language-row">
      <div className="row-label">
        <label htmlFor="target-language">{t('translation.targetLanguage', 'Target Language')}:</label>
      </div>
      <div className="row-content">
        <div className="language-inputs-container">
          {targetLanguages.map((lang) => (
            <div key={lang.id} className="language-input-group">
              <input
                id={`target-language-${lang.id}`}
                type="text"
                value={lang.value}
                onChange={(e) => onLanguageChange(lang.id, e.target.value)}
                placeholder={t('translation.languagePlaceholder', 'Enter target language (e.g., Spanish, Romanized Korean, Japanese)')}
                disabled={disabled}
                className="language-input"
              />
              {targetLanguages.length > 1 && (
                <button
                  className="remove-language-btn"
                  onClick={() => onRemoveLanguage(lang.id)}
                  disabled={disabled}
                  title={t('translation.removeLanguage', 'Remove')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                </button>
              )}
            </div>
          ))}
          <button
            className="add-language-btn"
            onClick={onAddLanguage}
            disabled={disabled}
            title={t('translation.addLanguage', 'Add Language')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>add</span>
            {t('translation.addLanguage', 'Add Language')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LanguageInputs;
