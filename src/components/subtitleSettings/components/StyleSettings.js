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
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>format_align_left</span>
              )}
              {option.value === 'center' && (
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>format_align_center</span>
              )}
              {option.value === 'right' && (
                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>format_align_right</span>
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
