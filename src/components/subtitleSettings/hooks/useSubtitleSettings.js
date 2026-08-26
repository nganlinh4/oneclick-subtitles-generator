import { useState, useEffect, useCallback } from 'react';
import { defaultSettings } from '../constants';

/**
 * Custom hook for managing subtitle settings
 * 
 * @param {Object} initialSettings - Initial settings
 * @param {Function} onSettingsChange - Callback when settings change
 * @returns {Object} - Settings state and handlers
 */
const useSubtitleSettings = (initialSettings, onSettingsChange, onResetSettings) => {
  const [isOpen, setIsOpen] = useState(() => {
    // Load isOpen state from localStorage
    const savedIsOpen = localStorage.getItem('subtitle_settings_panel_open');
    return savedIsOpen === 'true';
  });

  const subtitleLanguage = initialSettings.showTranslatedSubtitles ? 'translated' : 'original';

  // Save isOpen state to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('subtitle_settings_panel_open', isOpen.toString());
  }, [isOpen]);

  // Remove transparency mode from localStorage if it exists
  useEffect(() => {
    if (localStorage.getItem('subtitle_settings_panel_transparent')) {
      localStorage.removeItem('subtitle_settings_panel_transparent');
    }
  }, []);

  const handleSettingsChange = useCallback((updates) => {
    const updatedSettings = {
      ...initialSettings,
      ...updates,
    };

    onSettingsChange(updatedSettings);
  }, [initialSettings, onSettingsChange]);

  const handleSettingChange = useCallback((setting, value) => {
    handleSettingsChange({ [setting]: value });
  }, [handleSettingsChange]);

  const handleSubtitleLanguageChange = useCallback((e) => {
    const value = e.target.value;
    const showTranslated = value === 'translated';
    handleSettingChange('showTranslatedSubtitles', showTranslated);
  }, [handleSettingChange]);

  const resetToDefaults = () => {
    if (typeof onResetSettings === 'function') {
      onResetSettings();
    } else {
      onSettingsChange(defaultSettings);
    }
  };

  return {
    isOpen,
    setIsOpen,
    subtitleLanguage,
    handleSettingChange,
    handleSettingsChange,
    handleSubtitleLanguageChange,
    resetToDefaults
  };
};

export default useSubtitleSettings;
