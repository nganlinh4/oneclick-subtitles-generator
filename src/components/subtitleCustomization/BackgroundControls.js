import React from 'react';
import { useTranslation } from 'react-i18next';
import StandardSlider from '../common/StandardSlider';
import SliderWithValue from '../common/SliderWithValue';
import CustomDropdown from '../common/CustomDropdown';
import { defaultCustomization } from '../SubtitleCustomizationPanel';

const BackgroundControls = ({ customization, onChange }) => {
  const { t } = useTranslation();

  const updateCustomization = (updates) => {
    onChange({ ...customization, ...updates, preset: 'custom' });
  };

  return (
    <>
      {/* Background Color */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.backgroundColor', 'Background Color')}</label>
        </div>
        <div className="row-content">
          <div className="color-control">
            <input
              type="color"
              value={customization.backgroundColor}
              onChange={(e) => updateCustomization({ backgroundColor: e.target.value })}
              className="color-picker"
            />
            <input
              type="text"
              value={customization.backgroundColor}
              onChange={(e) => updateCustomization({ backgroundColor: e.target.value })}
              placeholder="#000000"
              className="color-input"
            />
          </div>
        </div>
      </div>

      {/* Background Opacity */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.backgroundOpacity', 'Background Opacity')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.backgroundOpacity}
            onChange={(value) => updateCustomization({ backgroundOpacity: parseInt(value) })}
            min={0}
            max={100}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="background-opacity-slider"
            id="background-opacity-slider"
            ariaLabel={t('videoRendering.backgroundOpacity', 'Background Opacity')}
            formatValue={(v) => `${v}%`}
            defaultValue={defaultCustomization.backgroundOpacity}
          />
        </div>
      </div>

      {/* Border Radius */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.borderRadius', 'Border Radius')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.borderRadius}
            onChange={(value) => updateCustomization({ borderRadius: parseInt(value) })}
            min={0}
            max={100}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="border-radius-slider"
            id="border-radius-slider"
            ariaLabel={t('videoRendering.borderRadius', 'Border Radius')}
            formatValue={(v) => `${v}px`}
            defaultValue={defaultCustomization.borderRadius}
          />
        </div>
      </div>

      {/* Border Width */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.borderWidth', 'Border Width')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.borderWidth}
            onChange={(value) => updateCustomization({ borderWidth: parseInt(value) })}
            min={0}
            max={20}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="border-width-slider"
            id="border-width-slider"
            ariaLabel={t('videoRendering.borderWidth', 'Border Width')}
            formatValue={(v) => `${v}px`}
            defaultValue={defaultCustomization.borderWidth}
          />
        </div>
      </div>

      {/* Border Color */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.borderColor', 'Border Color')}</label>
        </div>
        <div className="row-content">
          <div className="color-control">
            <input
              type="color"
              value={customization.borderColor}
              onChange={(e) => updateCustomization({ borderColor: e.target.value })}
              className="color-picker"
            />
            <input
              type="text"
              value={customization.borderColor}
              onChange={(e) => updateCustomization({ borderColor: e.target.value })}
              placeholder="#ffffff"
              className="color-input"
            />
          </div>
        </div>
      </div>

      {/* Border Style */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.borderStyle', 'Border Style')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            value={customization.borderStyle}
            onChange={(value) => updateCustomization({ borderStyle: value })}
            options={[
              { value: 'none', label: t('videoRendering.none', 'None') },
              { value: 'solid', label: t('videoRendering.solid', 'Solid') },
              { value: 'dashed', label: t('videoRendering.dashed', 'Dashed') },
              { value: 'dotted', label: t('videoRendering.dotted', 'Dotted') },
              { value: 'double', label: t('videoRendering.double', 'Double') }
            ]}
            placeholder={t('videoRendering.selectBorderStyle', 'Select Border Style')}
          />
        </div>
      </div>
    </>
  );
};

export default BackgroundControls;
