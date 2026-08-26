import { useTranslation } from 'react-i18next';
import SliderWithValue from '../common/SliderWithValue';
import MaterialSwitch from '../common/MaterialSwitch';
import CustomDropdown from '../common/CustomDropdown';
import { defaultCustomization } from '../SubtitleCustomizationPanel';
import ColorControl from './ColorControl';
import { patchSubtitleCustomization } from './customizationUpdate';
import '../../styles/common/material-switch.css';

// These are CSS linear-gradient angles, not mathematical headings. Existing projects persisted
// these exact values when the legacy renderer passed them straight into `linear-gradient(...)`, so
// rotating the values would rotate old projects. The arrow describes the ramp from its start stop
// to its end stop: CSS zero degrees points up and increases clockwise.
const GRADIENT_DIRECTION_OPTIONS = Object.freeze([
  Object.freeze({ value: '0deg', label: 'Vertical ↑' }),
  Object.freeze({ value: '90deg', label: 'Horizontal →' }),
  Object.freeze({ value: '45deg', label: 'Diagonal ↗' }),
  Object.freeze({ value: '135deg', label: 'Diagonal ↘' }),
  Object.freeze({ value: '180deg', label: 'Vertical ↓' }),
  Object.freeze({ value: '270deg', label: 'Horizontal ←' }),
]);

const EffectsControls = ({ customization, onChange }) => {
  const { t } = useTranslation();

  const updateCustomization = (updates) => {
    onChange(patchSubtitleCustomization(updates));
  };

  return (
    <>
      {/* Text Shadow */}
      <div className="customization-row">
        <div className="row-label">
          <label htmlFor="subtitle-text-shadow-color">
            {t('videoRendering.textShadow', 'Text Shadow')}
          </label>
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
              <ColorControl
                id="subtitle-text-shadow-color"
                value={customization.textShadowColor}
                onChange={value => updateCustomization({ textShadowColor: value })}
                placeholder="#000000"
                ariaLabel={t('videoRendering.textShadow', 'Text Shadow')}
              />
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
          <label htmlFor="subtitle-glow-color">
            {t('videoRendering.glow', 'Glow Effect')}
          </label>
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
              <ColorControl
                id="subtitle-glow-color"
                value={customization.glowColor}
                onChange={value => updateCustomization({ glowColor: value })}
                placeholder="#ffffff"
                ariaLabel={t('videoRendering.glow', 'Glow Effect')}
              />
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
              <label htmlFor="subtitle-gradient-start-color">
                {t('videoRendering.gradientStart', 'Gradient Start')}
              </label>
            </div>
            <div className="row-content">
              <ColorControl
                id="subtitle-gradient-start-color"
                value={customization.gradientColorStart}
                onChange={value => updateCustomization({ gradientColorStart: value })}
                placeholder="#ff6b6b"
                ariaLabel={t('videoRendering.gradientStart', 'Gradient Start')}
              />
            </div>
          </div>

          <div className="customization-row">
            <div className="row-label">
              <label htmlFor="subtitle-gradient-end-color">
                {t('videoRendering.gradientEnd', 'Gradient End')}
              </label>
            </div>
            <div className="row-content">
              <ColorControl
                id="subtitle-gradient-end-color"
                value={customization.gradientColorEnd}
                onChange={value => updateCustomization({ gradientColorEnd: value })}
                placeholder="#4ecdc4"
                ariaLabel={t('videoRendering.gradientEnd', 'Gradient End')}
              />
            </div>
          </div>

          <div className="customization-row">
            <div className="row-label">
              <label htmlFor="subtitle-gradient-direction">{t('videoRendering.gradientDirection', 'Gradient Direction')}</label>
            </div>
            <div className="row-content">
              <CustomDropdown
                id="subtitle-gradient-direction"
                value={customization.gradientDirection}
                onChange={(value) => updateCustomization({ gradientDirection: value })}
                options={GRADIENT_DIRECTION_OPTIONS}
                dataSetting="gradient-direction"
                placeholder={t('videoRendering.selectDirection', 'Select Direction')}
              />
            </div>
          </div>
        </>
      )}

      {/* Text Stroke Effect */}
      <div className="customization-row">
        <div className="row-label">
          <label htmlFor="subtitle-stroke-color">
            {t('videoRendering.textStroke', 'Text Stroke')}
          </label>
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
              <ColorControl
                id="subtitle-stroke-color"
                value={customization.strokeColor}
                onChange={value => updateCustomization({ strokeColor: value })}
                placeholder="#000000"
                ariaLabel={t('videoRendering.textStroke', 'Text Stroke')}
              />
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
