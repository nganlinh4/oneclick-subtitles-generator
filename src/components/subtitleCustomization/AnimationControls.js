import React from 'react';
import { useTranslation } from 'react-i18next';
import StandardSlider from '../common/StandardSlider';
import SliderWithValue from '../common/SliderWithValue';
import CustomDropdown from '../common/CustomDropdown';
import { formatDecimal } from '../../utils/formatUtils';
import { getAnimationTypes, getAnimationEasing } from './fontOptions';
import { defaultCustomization } from '../SubtitleCustomizationPanel';

const AnimationControls = ({ customization, onChange }) => {
  const { t } = useTranslation();

  // Get localized options
  const animationTypes = getAnimationTypes(t);
  const animationEasing = getAnimationEasing(t);

  const updateCustomization = (updates) => {
    onChange({ ...customization, ...updates, preset: 'custom' });
  };

  return (
    <>
      {/* Animation Type */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.animationType', 'Animation Type')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            value={customization.animationType}
            onChange={(value) => updateCustomization({ animationType: value })}
            options={animationTypes.map(type => ({
              value: type.value,
              label: type.label
            }))}
            placeholder={t('videoRendering.selectAnimation', 'Select Animation')}
          />
        </div>
      </div>

      {/* Animation Easing */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.animationEasing', 'Animation Easing')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            value={customization.animationEasing}
            onChange={(value) => updateCustomization({ animationEasing: value })}
            options={animationEasing.map(easing => ({
              value: easing.value,
              label: easing.label
            }))}
            placeholder={t('videoRendering.selectEasing', 'Select Easing')}
          />
        </div>
      </div>

      {/* Fade In Duration */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.fadeInDuration', 'Fade In Duration')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.fadeInDuration}
            onChange={(value) => updateCustomization({ fadeInDuration: formatDecimal(value, 1) })}
            min={0}
            max={2.0}
            step={0.1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="fade-in-duration-slider"
            id="fade-in-duration-slider"
            ariaLabel={t('videoRendering.fadeInDuration', 'Fade In Duration')}
            formatValue={(v) => `${formatDecimal(v, 1)}s`}
            defaultValue={defaultCustomization.fadeInDuration}
          />
        </div>
      </div>

      {/* Fade Out Duration */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.fadeOutDuration', 'Fade Out Duration')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.fadeOutDuration}
            onChange={(value) => updateCustomization({ fadeOutDuration: formatDecimal(value, 1) })}
            min={0}
            max={2.0}
            step={0.1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="fade-out-duration-slider"
            id="fade-out-duration-slider"
            ariaLabel={t('videoRendering.fadeOutDuration', 'Fade Out Duration')}
            formatValue={(v) => `${formatDecimal(v, 1)}s`}
            defaultValue={defaultCustomization.fadeOutDuration}
          />
        </div>
      </div>
    </>
  );
};

export default AnimationControls;
