import React from 'react';
import { useTranslation } from 'react-i18next';
import StandardSlider from '../common/StandardSlider';
import SliderWithValue from '../common/SliderWithValue';
import MaterialSwitch from '../common/MaterialSwitch';
import CustomDropdown from '../common/CustomDropdown';
import { defaultCustomization } from '../SubtitleCustomizationPanel';
import '../../styles/common/material-switch.css';

const EffectsControls = ({ customization, onChange }) => {
  const { t } = useTranslation();

  const updateCustomization = (updates) => {
    onChange({ ...customization, ...updates, preset: 'custom' });
  };

  return (
    <>
      {/* Text Shadow */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.textShadow', 'Text Shadow')}</label>
        </div>
        <div className="row-content">
          <div className="toggle-control">
            <div className="material-switch-container">
              <MaterialSwitch
                id="text-shadow-enabled"
                checked={customization.textShadowEnabled}
                onChange={(e) => updateCustomization({ textShadowEnabled: e.target.checked })}
                ariaLabel={t('videoRendering.textShadow', 'Text Shadow')}
                icons={true}
              />
            </div>
            {customization.textShadowEnabled && (
              <div className="color-control">
                <input
                  type="color"
                  value={customization.textShadowColor}
                  onChange={(e) => updateCustomization({ textShadowColor: e.target.value })}
                  className="color-picker"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Shadow Blur */}
      {customization.textShadowEnabled && (
        <div className="customization-row">
          <div className="row-label">
            <label>{t('videoRendering.shadowBlur', 'Shadow Blur')}</label>
          </div>
          <div className="row-content">
            <SliderWithValue
              value={customization.textShadowBlur}
              onChange={(value) => updateCustomization({ textShadowBlur: parseInt(value) })}
              min={0}
              max={50}
              step={1}
              orientation="Horizontal"
              size="XSmall"
              state="Enabled"
              className="shadow-blur-slider"
              id="shadow-blur-slider"
              ariaLabel={t('videoRendering.shadowBlur', 'Shadow Blur')}
              formatValue={(v) => `${v}px`}
              defaultValue={defaultCustomization.textShadowBlur}
            />
          </div>
        </div>
      )}

      {/* Shadow Offset */}
      {customization.textShadowEnabled && (
        <div className="customization-row">
          <div className="row-label">
            <label>{t('videoRendering.shadowOffset', 'Shadow Offset')}</label>
          </div>
          <div className="row-content">
            <SliderWithValue
              value={customization.textShadowOffsetY}
              onChange={(value) => updateCustomization({ textShadowOffsetY: parseInt(value) })}
              min={-25}
              max={25}
              step={1}
              orientation="Horizontal"
              size="XSmall"
              state="Enabled"
              className="shadow-offset-slider"
              id="shadow-offset-slider"
              ariaLabel={t('videoRendering.shadowOffset', 'Shadow Offset')}
              formatValue={(v) => `${v}px`}
              defaultValue={defaultCustomization.textShadowOffsetY}
            />
          </div>
        </div>
      )}

      {/* Glow Effect */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.glow', 'Glow Effect')}</label>
        </div>
        <div className="row-content">
          <div className="toggle-control">
            <div className="material-switch-container">
              <MaterialSwitch
                id="glow-enabled"
                checked={customization.glowEnabled}
                onChange={(e) => updateCustomization({ glowEnabled: e.target.checked })}
                ariaLabel={t('videoRendering.glow', 'Glow Effect')}
                icons={true}
              />
            </div>
            {customization.glowEnabled && (
              <div className="color-control">
                <input
                  type="color"
                  value={customization.glowColor}
                  onChange={(e) => updateCustomization({ glowColor: e.target.value })}
                  className="color-picker"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Glow Intensity */}
      {customization.glowEnabled && (
        <div className="customization-row">
          <div className="row-label">
            <label>{t('videoRendering.glowIntensity', 'Glow Intensity')}</label>
          </div>
          <div className="row-content">
            <SliderWithValue
              value={customization.glowIntensity}
              onChange={(value) => updateCustomization({ glowIntensity: parseInt(value) })}
              min={0}
              max={100}
              step={1}
              orientation="Horizontal"
              size="XSmall"
              state="Enabled"
              className="glow-intensity-slider"
              id="glow-intensity-slider"
              ariaLabel={t('videoRendering.glowIntensity', 'Glow Intensity')}
              formatValue={(v) => `${v}px`}
              defaultValue={defaultCustomization.glowIntensity}
            />
          </div>
        </div>
      )}

      {/* Gradient Text Effect */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.gradientText', 'Gradient Text')}</label>
        </div>
        <div className="row-content">
          <div className="toggle-control">
            <div className="material-switch-container">
              <MaterialSwitch
                id="gradient-enabled"
                checked={customization.gradientEnabled}
                onChange={(e) => updateCustomization({ gradientEnabled: e.target.checked })}
                ariaLabel={t('videoRendering.gradient', 'Gradient')}
                icons={true}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Gradient Colors */}
      {customization.gradientEnabled && (
        <>
          <div className="customization-row">
            <div className="row-label">
              <label>{t('videoRendering.gradientStart', 'Gradient Start')}</label>
            </div>
            <div className="row-content">
              <div className="color-control">
                <input
                  type="color"
                  value={customization.gradientColorStart}
                  onChange={(e) => updateCustomization({ gradientColorStart: e.target.value })}
                  className="color-picker"
                />
                <input
                  type="text"
                  value={customization.gradientColorStart}
                  onChange={(e) => updateCustomization({ gradientColorStart: e.target.value })}
                  placeholder="#ff6b6b"
                  className="color-input"
                />
              </div>
            </div>
          </div>

          <div className="customization-row">
            <div className="row-label">
              <label>{t('videoRendering.gradientEnd', 'Gradient End')}</label>
            </div>
            <div className="row-content">
              <div className="color-control">
                <input
                  type="color"
                  value={customization.gradientColorEnd}
                  onChange={(e) => updateCustomization({ gradientColorEnd: e.target.value })}
                  className="color-picker"
                />
                <input
                  type="text"
                  value={customization.gradientColorEnd}
                  onChange={(e) => updateCustomization({ gradientColorEnd: e.target.value })}
                  placeholder="#4ecdc4"
                  className="color-input"
                />
              </div>
            </div>
          </div>

          <div className="customization-row">
            <div className="row-label">
              <label>{t('videoRendering.gradientDirection', 'Gradient Direction')}</label>
            </div>
            <div className="row-content">
              <CustomDropdown
                value={customization.gradientDirection}
                onChange={(value) => updateCustomization({ gradientDirection: value })}
                options={[
                  { value: '0deg', label: 'Horizontal →' },
                  { value: '90deg', label: 'Vertical ↓' },
                  { value: '45deg', label: 'Diagonal ↘' },
                  { value: '135deg', label: 'Diagonal ↙' },
                  { value: '180deg', label: 'Horizontal ←' },
                  { value: '270deg', label: 'Vertical ↑' }
                ]}
                placeholder={t('videoRendering.selectDirection', 'Select Direction')}
              />
            </div>
          </div>
        </>
      )}

      {/* Text Stroke Effect */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.textStroke', 'Text Stroke')}</label>
        </div>
        <div className="row-content">
          <div className="toggle-control">
            <div className="material-switch-container">
              <MaterialSwitch
                id="stroke-enabled"
                checked={customization.strokeEnabled}
                onChange={(e) => updateCustomization({ strokeEnabled: e.target.checked })}
                ariaLabel={t('videoRendering.stroke', 'Stroke')}
                icons={true}
              />
            </div>
            {customization.strokeEnabled && (
              <div className="color-control">
                <input
                  type="color"
                  value={customization.strokeColor}
                  onChange={(e) => updateCustomization({ strokeColor: e.target.value })}
                  className="color-picker"
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stroke Width */}
      {customization.strokeEnabled && (
        <div className="customization-row">
          <div className="row-label">
            <label>{t('videoRendering.strokeWidth', 'Stroke Width')}</label>
          </div>
          <div className="row-content">
            <SliderWithValue
              value={customization.strokeWidth}
              onChange={(value) => updateCustomization({ strokeWidth: parseFloat(value) })}
              min={0}
              max={10}
              step={0.1}
              orientation="Horizontal"
              size="XSmall"
              state="Enabled"
              className="stroke-width-slider"
              id="stroke-width-slider"
              ariaLabel={t('videoRendering.strokeWidth', 'Stroke Width')}
              formatValue={(v) => `${Number(v).toFixed(1)}px`}
              defaultValue={defaultCustomization.strokeWidth}
            />
          </div>
        </div>
      )}
    </>
  );
};

export default EffectsControls;
