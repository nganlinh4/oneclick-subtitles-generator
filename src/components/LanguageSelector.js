import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import CustomDropdown from './common/CustomDropdown';
import { PREFERRED_LANGUAGE_PREFERENCE } from '../platform/nativeUiPreferences';
import { showPreferenceProjectionWarning } from './settings/utils/preferenceProjectionWarning';

const LanguageSelector = ({ disabled = false }) => {
  const { t, i18n } = useTranslation();
  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language);
  const languageWriteInFlightRef = useRef(false);

  // Language options with their details
  const languages = [
    { code: 'en', name: t('language.en'), flag: '🇺🇸' },
    { code: 'ko', name: t('language.ko'), flag: '🇰🇷' },
    { code: 'vi', name: t('language.vi'), flag: '🇻🇳' }
  ];

  // Render label with proper spacing between flag and language
  const renderLabel = (lang) => (
    <span className="lang-option">
      <span className="flag" aria-hidden="true">{lang.flag}</span>
      <span className="name">{lang.name}</span>
    </span>
  );


  // Prepare options for CustomDropdown - use JSX to control spacing/styles
  const dropdownOptions = languages.map((lang) => ({
    value: lang.code,
    label: renderLabel(lang),
  }));

  // Function to change the language
  const handleLanguageChange = async (code) => {
    if (disabled || languageWriteInFlightRef.current) return;
    languageWriteInFlightRef.current = true;
    try {
      const committedLanguage = await PREFERRED_LANGUAGE_PREFERENCE.commit(code, {
        apply: (language) => i18n.changeLanguage(language),
        onProjectionWarning: () => showPreferenceProjectionWarning(t),
      });
      // Keep this control aligned with durable native authority even if i18n could not repaint the
      // rest of this WebView. The keyed warning explains that restart may be needed.
      setSelectedLanguage(committedLanguage);
    } catch {
      window.addToast?.(
        t('settings.saveFailed', 'Settings could not be saved. Please try again.'),
        'error',
        8000,
      );
    } finally {
      languageWriteInFlightRef.current = false;
    }
  };

  // Use effect to sync with i18n language changes
  useEffect(() => {
    const handleLanguageChanged = () => {
      setSelectedLanguage(i18n.language);
    };

    i18n.on('languageChanged', handleLanguageChanged);

    return () => {
      i18n.off('languageChanged', handleLanguageChanged);
    };
  }, [i18n]);

  return (
    <CustomDropdown
      value={selectedLanguage}
      onChange={handleLanguageChange}
      options={dropdownOptions}
      placeholder={t('language.selectLanguage') || 'Select language'}
      disabled={disabled}
    />
  );
};

export default LanguageSelector;
