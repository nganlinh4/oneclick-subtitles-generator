import React from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import MaterialSwitch from '../../common/MaterialSwitch';
import CustomDropdown from '../../common/CustomDropdown';
import '../../../styles/common/material-switch.css';

/**
 * Style Settings component
 * 
 * @param {Object} props - Component props
 * @param {Object} props.settings - Current subtitle settings
 * @param {Function} props.handleSettingChange - Function to handle setting changes
 * @param {Array} props.textAlignOptions - Text alignment options
 * @param {Array} props.textTransformOptions - Text transform options
 * @returns {JSX.Element} - Rendered component
 */
const StyleSettings = ({ settings, handleSettingChange, textAlignOptions, textTransformOptions }) => {
  const { t } = useTranslation();

  return (
    <>
      <div className="setting-group">
        <label htmlFor="background-color">{t('subtitleSettings.backgroundColor', 'Background Color')}</label>
        <input
          type="color"
          id="background-color"
          value={settings.backgroundColor}
          onChange={(e) => handleSettingChange('backgroundColor', e.target.value)}
        />
      </div>

      <div className="setting-group">
        <label htmlFor="opacity">{t('subtitleSettings.opacity', 'Opacity')}</label>
        <SliderWithValue
          value={parseFloat(settings.opacity)}
          onChange={(value) => handleSettingChange('opacity', value.toString())}
          min={0}
          max={1}
          step={0.1}
          orientation="Horizontal"
          size="XSmall"
          state="Enabled"
          className="opacity-slider"
          id="opacity"
          ariaLabel={t('subtitleSettings.opacity', 'Opacity')}
          formatValue={(v) => `${Math.round(Number(v) * 100)}%`}
        />
      </div>

      <div className="setting-group">
        <label htmlFor="text-color">{t('subtitleSettings.textColor', 'Text Color')}</label>
        <input
          type="color"
          id="text-color"
          value={settings.textColor}
          onChange={(e) => handleSettingChange('textColor', e.target.value)}
        />
      </div>

      <div className="setting-group">
        <label htmlFor="text-align">{t('subtitleSettings.textAlign', 'Text Alignment')}</label>
        <div className="button-toggle-group">
          {textAlignOptions.map(option => (
            <button
              key={option.value}
              className={`button-toggle ${settings.textAlign === option.value ? 'active' : ''}`}
              onClick={() => handleSettingChange('textAlign', option.value)}
              title={option.label}
            >
              {option.value === 'left' && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="3" y1="12" x2="15" y2="12"></line>
                  <line x1="3" y1="18" x2="18" y2="18"></line>
                </svg>
              )}
              {option.value === 'center' && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="6" y1="12" x2="18" y2="12"></line>
                  <line x1="4" y1="18" x2="20" y2="18"></line>
                </svg>
              )}
              {option.value === 'right' && (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6"></line>
                  <line x1="9" y1="12" x2="21" y2="12"></line>
                  <line x1="6" y1="18" x2="21" y2="18"></line>
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-group">
        <label htmlFor="text-transform">{t('subtitleSettings.textTransform', 'Text Transform')}</label>
        <CustomDropdown
          value={settings.textTransform || 'none'}
          onChange={(value) => handleSettingChange('textTransform', value)}
          options={textTransformOptions.map(option => ({
            value: option.value,
            label: option.label
          }))}
          placeholder={t('subtitleSettings.selectTextTransform', 'Select Text Transform')}
        />
      </div>

      <div className="setting-group">
        <label>{t('subtitleSettings.textShadow', 'Text Shadow')}</label>
        <div className="material-switch-container">
          <MaterialSwitch
            id="text-shadow"
            checked={settings.textShadow === 'true' || settings.textShadow === true}
            onChange={(e) => handleSettingChange('textShadow', e.target.checked)}
            ariaLabel={t('subtitleSettings.textShadow', 'Text Shadow')}
            icons={true}
          />
          <label htmlFor="text-shadow" className="material-switch-label">
            {settings.textShadow === 'true' || settings.textShadow === true
              ? t('common.on', 'On')
              : t('common.off', 'Off')}
          </label>
        </div>
      </div>
    </>
  );
};

export default StyleSettings;
