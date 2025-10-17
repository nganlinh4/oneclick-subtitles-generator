import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Component for language code input fields
 * @param {Object} props - Component props
 * @param {Array} props.languageCodes - Array of language codes
 * @param {Function} props.onChange - Function to call when language codes change
 * @returns {JSX.Element} - Rendered component
 */
const LanguageCodeInput = ({ languageCodes = [''], onChange }) => {
  const { t } = useTranslation();

  // Handle language code change
  const handleLanguageCodeChange = (index, value) => {
    const newCodes = [...languageCodes];
    newCodes[index] = value;
    onChange(newCodes);
  };

  // Handle adding a new language code
  const handleAddLanguageCode = () => {
    onChange([...languageCodes, '']);
  };

  // Handle removing a language code
  const handleRemoveLanguageCode = (index) => {
    const newCodes = [...languageCodes];
    newCodes.splice(index, 1);
    onChange(newCodes);
  };

  return (
    <div className="language-codes-container">
      {languageCodes.map((code, index) => (
        <div key={index} className="language-code-field">
          <input
            type="text"
            className="language-code-input"
            value={code}
            onChange={(e) => handleLanguageCodeChange(index, e.target.value)}
            placeholder={t('settings.modelManagement.languageCode')}
          />

          {/* Remove button for all except the first language code */}
          {index > 0 && (
            <button
              className="delete-model-btn"
              onClick={() => handleRemoveLanguageCode(index)}
              title={t('settings.modelManagement.removeLanguageCode', 'Remove language code')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>delete</span>
            </button>
          )}
        </div>
      ))}

      {/* Add language code button */}
      <button
        className="add-language-btn"
        onClick={handleAddLanguageCode}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 20 }}>add</span>
        {t('settings.modelManagement.addLanguageCode', 'Add language code')}
      </button>
    </div>
  );
};

export default LanguageCodeInput;
