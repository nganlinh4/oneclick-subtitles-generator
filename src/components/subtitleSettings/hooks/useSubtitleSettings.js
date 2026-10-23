import { useCallback } from 'react';
import { defaultSettings } from '../constants';
import { usePreference } from '../../../platform/preferences/store';

/**
 * Custom hook for managing subtitle settings
 * 
 * @param {Object} initialSettings - Initial settings
 * @param {Function} onSettingsChange - Callback when settings change
 * @returns {Object} - Settings state and handlers
 */
const useSubtitleSettings = (initialSettings, onSettingsChange, onResetSettings) => {
  const [isOpen, setIsOpen] = usePreference('subtitle_settings_panel_open');

  const subtitleLanguage = initialSettings.showTranslatedSubtitles ? 'translated' : 'original';


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
