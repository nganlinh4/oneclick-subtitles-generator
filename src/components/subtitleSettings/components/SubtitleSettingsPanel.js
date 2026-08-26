import React from 'react';
import { useTranslation } from 'react-i18next';
import FontSettings from './FontSettings';
import PositionSettings from './PositionSettings';
import StyleSettings from './StyleSettings';
import { getTextAlignOptions, getTextTransformOptions } from '../constants';
import CustomDropdown from '../../common/CustomDropdown';
import { fontOptions, getFontWeightOptions } from '../../subtitleCustomization/fontOptions';
import {
  fontSelectionModel,
  selectableFontWeights,
  systemFontProbe,
} from '../../../services/selectableFonts';
import { useFontReadiness } from '../../../services/useFontReadiness';

/** Mount the renderer probe only while the settings panel is actually visible. */
const RendererBackedFontSettings = ({ settings, handleSettingChange, handleSettingsChange, t }) => {
  const fontCapability = useFontReadiness();
  const isSystemFaceInstalled = React.useMemo(() => systemFontProbe(), []);
  const requestedWeight = Number(settings.fontWeight);
  const fontModel = React.useMemo(() => fontSelectionModel(fontOptions, {
    fontFamily: settings.fontFamily,
    fontWeight: requestedWeight,
    capability: fontCapability,
    isSystemFaceInstalled,
  }), [fontCapability, isSystemFaceInstalled, requestedWeight, settings.fontFamily]);
  const exactFontWeights = React.useMemo(() => selectableFontWeights({
    fontFamily: settings.fontFamily,
    capability: fontCapability,
    isSystemFaceInstalled,
  }), [fontCapability, isSystemFaceInstalled, settings.fontFamily]);
  const exactWeightSet = new Set(exactFontWeights);
  const fontWeightOptions = getFontWeightOptions(t)
    .filter(({ value }) => exactWeightSet.has(value))
    .map(option => ({ ...option, value: String(option.value) }));

  return (
    <FontSettings
      settings={settings}
      handleSettingChange={handleSettingChange}
      handleSettingsChange={handleSettingsChange}
      fontOptions={fontModel.options}
      selectedFontValue={fontModel.selectedOption?.value ?? settings.fontFamily}
      fontWeightOptions={fontWeightOptions}
    />
  );
};

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
  handleSettingsChange,
  subtitleLanguage,
  handleSubtitleLanguageChange,
  hasTranslation,
  targetLanguage,
  resetToDefaults
}) => {
  const { t } = useTranslation();

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
          <label id="subtitle-language-label" htmlFor="subtitle-language">{t('subtitleSettings.subtitleLanguage', 'Subtitle Language')}</label>
          <CustomDropdown
            id="subtitle-language"
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
            dataSetting="subtitle-language"
            ariaLabelledBy="subtitle-language-label"
            placeholder={t('subtitleSettings.selectLanguage', 'Select Language')}
          />
        </div>

        <hr className="settings-divider" />

        {/* Font Settings */}
        <RendererBackedFontSettings
          settings={settings}
          handleSettingChange={handleSettingChange}
          handleSettingsChange={handleSettingsChange}
          t={t}
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
