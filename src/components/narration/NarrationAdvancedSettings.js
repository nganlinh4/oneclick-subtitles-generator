import React from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../common/SliderWithValue';
import MaterialSwitch from '../common/MaterialSwitch';
import '../../styles/common/material-switch.css';
import '../../styles/narration/narrationAdvancedSettingsRedesign.css';

/**
 * Narration Advanced Settings component - Redesigned with Material Design 3
 * @param {Object} props - Component props
 * @param {Object} props.settings - Advanced settings
 * @param {Function} props.onSettingsChange - Function to update settings
 * @param {boolean} props.disabled - Whether settings are disabled
 * @returns {JSX.Element} - Rendered component
 */
const NarrationAdvancedSettings = ({ settings, onSettingsChange, disabled = false }) => {
  const { t } = useTranslation();

  // Handle setting changes
  const handleSettingChange = (key, value) => {
    onSettingsChange({
      ...settings,
      [key]: value
    });
  };

  // Handle slider changes for StandardSlider
  const handleSliderChange = (name, value) => {
    handleSettingChange(name, parseFloat(value));
  };

  // Handle checkbox changes
  const handleCheckboxChange = (e) => {
    const { name, checked } = e.target;
    handleSettingChange(name, checked);
  };

  // Handle radio changes
  const handleRadioChange = (name, value) => {
    handleSettingChange(name, value);
  };

  return (
    <div className="advanced-settings">
      <div className="settings-grid">
        {/* Voice Style Controls */}
        <div className="settings-section">
          <h4 className="settings-section-title">
            {t('narration.voiceStyle', 'Voice Style')}
          </h4>

          <div className="narration-row">
            <div className="row-label">
              <label htmlFor="speechRate">{t('narration.speechRate', 'Speed')}:</label>
            </div>
            <div className="row-content">
              <SliderWithValue
                value={settings.speechRate || 1.1}
                onChange={(value) => handleSliderChange('speechRate', value)}
                min={0.5}
                max={2.0}
                step={0.1}
                orientation="Horizontal"
                size="XSmall"
                state={disabled ? "Disabled" : "Enabled"}
                className="speech-rate-slider"
                id="speechRate"
                ariaLabel={t('narration.speechRate', 'Speed')}
                formatValue={(v) => `${Number(v || 1.1).toFixed(1)}x`}
              />
            </div>
          </div>

          <div className="narration-row">
            <div className="row-label">
              <label htmlFor="cfgStrength">{t('narration.cfgStrength', 'Similarity')}:</label>
            </div>
            <div className="row-content">
              <SliderWithValue
                value={settings.cfgStrength || 2.0}
                onChange={(value) => handleSliderChange('cfgStrength', value)}
                min={1.0}
                max={5.0}
                step={0.1}
                orientation="Horizontal"
                size="XSmall"
                state={disabled ? "Disabled" : "Enabled"}
                className="cfg-strength-slider"
                id="cfgStrength"
                ariaLabel={t('narration.cfgStrength', 'Similarity')}
                formatValue={(v) => `${Number(v || 2.0).toFixed(1)}`}
              />
              <div className="setting-description">
                {t('narration.cfgStrengthDesc', 'Higher values increase voice similarity')}
              </div>
            </div>
          </div>
        </div>

        {/* Generation Quality Controls */}
        <div className="settings-section">
          <h4 className="settings-section-title">
            {t('narration.generationQuality', 'Quality')}
          </h4>

          <div className="narration-row">
            <div className="row-label">
              <label>{t('narration.nfeStep', 'Steps')}:</label>
            </div>
            <div className="row-content">
              <div className="radio-pill-group">
                {['8', '16', '32', '64'].map((value) => (
                  <div className="radio-pill" key={value}>
                    <input
                      type="radio"
                      id={`nfeStep-${value}`}
                      name="nfeStep"
                      checked={String(settings.nfeStep) === value}
                      onChange={() => handleRadioChange('nfeStep', value)}
                      disabled={disabled}
                    />
                    <label htmlFor={`nfeStep-${value}`}>{value}</label>
                  </div>
                ))}
              </div>
              <div className="setting-description">
                {t('narration.nfeStepDesc', 'Higher values improve quality but take longer')}
              </div>
            </div>
          </div>

          <div className="narration-row">
            <div className="row-label">
              <label htmlFor="swayCoef">{t('narration.swayCoef', 'Sway')}:</label>
            </div>
            <div className="row-content">
              <SliderWithValue
                value={settings.swayCoef || -1.0}
                onChange={(value) => handleSliderChange('swayCoef', value)}
                min={-1.1}
                max={1.7}
                step={0.1}
                orientation="Horizontal"
                size="XSmall"
                state={disabled ? "Disabled" : "Enabled"}
                className="sway-coef-slider"
                id="swayCoef"
                ariaLabel={t('narration.swayCoef', 'Sway')}
                formatValue={(v) => `${Number(v || -1.0).toFixed(1)}`}
              />
              <div className="setting-description">
                {t('narration.swayCoefDesc', 'Lower values improve quality')}
              </div>
            </div>
          </div>
        </div>

        {/* Seed Control */}
        <div className="settings-section">
          <h4 className="settings-section-title">
            {t('narration.seedControl', 'Seed')}
          </h4>

          <div className="narration-row">
            <div className="row-label">
              <label>{t('narration.randomSeed', 'Random')}:</label>
            </div>
            <div className="row-content">
              <div className="material-switch-container">
                <MaterialSwitch
                  id="use-random-seed"
                  checked={settings.useRandomSeed !== false}
                  onChange={(e) => handleCheckboxChange({ target: { name: 'useRandomSeed', checked: e.target.checked } })}
                  disabled={disabled}
                  ariaLabel={t('narration.useRandomSeed', 'Use random seed')}
                  icons={true}
                />
                <span>{t('narration.useRandomSeed', 'Use random seed')}</span>
              </div>
            </div>
          </div>

          {settings.useRandomSeed === false && (
            <div className="narration-row">
              <div className="row-label">
                <label htmlFor="seed">{t('narration.seed', 'Value')}:</label>
              </div>
              <div className="row-content">
                <input
                  type="number"
                  id="seed"
                  name="seed"
                  value={settings.seed || 42}
                  onChange={(e) => handleSettingChange('seed', parseInt(e.target.value) || 0)}
                  disabled={disabled}
                  className="number-input"
                  min="0"
                  max="999999"
                />
              </div>
            </div>
          )}
        </div>

        {/* Audio Processing Options */}
        <div className="settings-section">
          <h4 className="settings-section-title">
            {t('narration.audioProcessing', 'Processing')}
          </h4>

          <div className="narration-row">
            <div className="row-label">
              <label>{t('narration.removeSilence', 'Silence')}:</label>
            </div>
            <div className="row-content">
              <div className="material-switch-container">
                <MaterialSwitch
                  id="remove-silence"
                  checked={settings.removeSilence !== false}
                  onChange={(e) => handleCheckboxChange({ target: { name: 'removeSilence', checked: e.target.checked } })}
                  disabled={disabled}
                  ariaLabel={t('narration.removeSilenceDesc', 'Remove silence')}
                  icons={true}
                />
                <span>{t('narration.removeSilenceDesc', 'Remove silence')}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Output Format Options */}
        <div className="settings-section">
          <h4 className="settings-section-title">
            {t('narration.outputFormat', 'Output')}
          </h4>

          <div className="narration-row">
            <div className="row-label">
              <label>{t('narration.sampleRate', 'Sample Rate')}:</label>
            </div>
            <div className="row-content">
              <div className="radio-pill-group">
                {['22050', '44100', '48000'].map((value) => (
                  <div className="radio-pill" key={value}>
                    <input
                      type="radio"
                      id={`sampleRate-${value}`}
                      name="sampleRate"
                      checked={String(settings.sampleRate) === value}
                      onChange={() => handleRadioChange('sampleRate', value)}
                      disabled={disabled}
                    />
                    <label htmlFor={`sampleRate-${value}`}>{value} Hz</label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="narration-row">
            <div className="row-label">
              <label>{t('narration.audioFormat', 'Format')}:</label>
            </div>
            <div className="row-content">
              <div className="radio-pill-group">
                <div className="radio-pill">
                  <input
                    type="radio"
                    id="audioFormat-wav"
                    name="audioFormat"
                    checked={true}
                    onChange={() => handleRadioChange('audioFormat', 'wav')}
                    disabled={disabled}
                  />
                  <label htmlFor="audioFormat-wav">WAV</label>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Batch Processing Options */}
        <div className="settings-section">
          <h4 className="settings-section-title">
            {t('narration.batchProcessing', 'Batch')}
          </h4>

          <div className="narration-row">
            <div className="row-label">
              <label>{t('narration.batchSize', 'Batch Size')}:</label>
            </div>
            <div className="row-content">
              <div className="radio-pill-group">
                {['1', '2', '4', '8', '16', '32', '64', 'all'].map((value) => (
                  <div className="radio-pill" key={value}>
                    <input
                      type="radio"
                      id={`batchSize-${value}`}
                      name="batchSize"
                      checked={settings.batchSize === value}
                      onChange={() => handleRadioChange('batchSize', value)}
                      disabled={disabled}
                    />
                    <label htmlFor={`batchSize-${value}`}>
                      {value === 'all' ? t('narration.all', 'All') : value}
                    </label>
                  </div>
                ))}
              </div>
              <div className="setting-description">
                {t('narration.batchSizeDesc', 'Set this smaller if your GPU cannot handle')}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NarrationAdvancedSettings;
