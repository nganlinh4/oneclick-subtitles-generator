import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import CustomDropdown from './common/CustomDropdown';

const LanguageSelector = () => {
  const { t, i18n } = useTranslation();
  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language);

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
  const handleLanguageChange = (code) => {
    i18n.changeLanguage(code);
    setSelectedLanguage(code);
    localStorage.setItem('preferred_language', code);
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
    />
  );
};

export default LanguageSelector;
