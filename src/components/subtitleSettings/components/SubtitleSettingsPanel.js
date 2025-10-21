import React from 'react';
import { useTranslation } from 'react-i18next';
import FontSettings from './FontSettings';
import PositionSettings from './PositionSettings';
import StyleSettings from './StyleSettings';
import { fontOptions, getFontWeightOptions, getTextAlignOptions, getTextTransformOptions } from '../constants';
import { groupFontsByCategory } from '../utils/fontUtils';
import CustomDropdown from '../../common/CustomDropdown';

/**
 * Subtitle Settings Panel component
 * 
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the panel is open
 * @param {Function} props.setIsOpen - Function to set isOpen state
 * @param {Object} props.settings - Current subtitle settings
 * @param {Function} props.handleSettingChange - Function to handle setting changes
 * @param {string} props.subtitleLanguage - Current subtitle language
 * @param {Function} props.handleSubtitleLanguageChange - Function to handle subtitle language changes
 * @param {boolean} props.hasTranslation - Whether translation is available
 * @param {string} props.targetLanguage - Target language for translation
 * @param {Function} props.resetToDefaults - Function to reset settings to defaults
 * @returns {JSX.Element} - Rendered component
 */
const SubtitleSettingsPanel = ({
  isOpen,
  setIsOpen,
  settings,
  handleSettingChange,
  subtitleLanguage,
  handleSubtitleLanguageChange,
  hasTranslation,
  targetLanguage,
  resetToDefaults
}) => {
  const { t } = useTranslation();
  
  // Group fonts for the select element
  const fontGroups = groupFontsByCategory(fontOptions);

  // Handle click outside to close
  React.useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event) => {
      // Check if click is outside the panel
      const panel = document.querySelector('.subtitle-settings-panel');
      const toggleButton = document.querySelector('.subtitle-settings-toggle');
      
      if (panel && !panel.contains(event.target) && 
          toggleButton && !toggleButton.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    // Add event listeners
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    // Cleanup
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, setIsOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Invisible backdrop for click detection */}
      <div className="subtitle-settings-backdrop" onClick={() => setIsOpen(false)} />
      
      <div className="subtitle-settings-panel">
        <div className="settings-content">
        {/* Subtitle Language Selector - Always shown at the top */}
        <div className="setting-group subtitle-language-group">
          <label htmlFor="subtitle-language">{t('subtitleSettings.subtitleLanguage', 'Subtitle Language')}</label>
          <CustomDropdown
            value={subtitleLanguage}
            onChange={(value) => handleSubtitleLanguageChange({ target: { value } })}
            disabled={!hasTranslation}
            options={[
              { value: 'original', label: t('subtitleSettings.original', 'Original') },
              ...(hasTranslation ? [{
                value: 'translated',
                label: `${t('subtitleSettings.translated', 'Translated')}${targetLanguage ? ` (${targetLanguage})` : ''}`
              }] : [])
            ]}
            placeholder={t('subtitleSettings.selectLanguage', 'Select Language')}
          />
        </div>

        <hr className="settings-divider" />

        {/* Font Settings */}
        <FontSettings
          settings={settings}
          handleSettingChange={handleSettingChange}
          fontGroups={fontGroups}
          fontWeightOptions={getFontWeightOptions(t)}
        />

        {/* Position Settings */}
        <PositionSettings
          settings={settings}
          handleSettingChange={handleSettingChange}
        />

        {/* Style Settings */}
        <StyleSettings
          settings={settings}
          handleSettingChange={handleSettingChange}
          textAlignOptions={getTextAlignOptions(t)}
          textTransformOptions={getTextTransformOptions(t)}
        />

        <button
          className="reset-settings-btn"
          onClick={resetToDefaults}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>refresh</span>
          {t('subtitleSettings.resetToDefault', 'Reset to Default')}
        </button>
      </div>
    </div>
    </>
  );
};

export default SubtitleSettingsPanel;
