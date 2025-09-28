import React from 'react';
import { useTranslation } from 'react-i18next';
import StandardSlider from '../common/StandardSlider';
import SliderWithValue from '../common/SliderWithValue';
import CustomDropdown from '../common/CustomDropdown';
import { defaultCustomization } from '../SubtitleCustomizationPanel';

const PositionControls = ({ customization, onChange }) => {
  const { t } = useTranslation();

  const updateCustomization = (updates) => {
    onChange({ ...customization, ...updates, preset: 'custom' });
  };

  return (
    <>
      {/* Position */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.position', 'Position')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            value={customization.position}
            onChange={(value) => updateCustomization({ position: value })}
            options={[
              { value: 'bottom', label: t('videoRendering.bottom', 'Bottom') },
              { value: 'top', label: t('videoRendering.top', 'Top') },
              { value: 'center', label: t('videoRendering.center', 'Center') },
              { value: 'custom', label: t('videoRendering.custom', 'Custom') }
            ]}
            placeholder={t('videoRendering.selectPosition', 'Select Position')}
          />
        </div>
      </div>

      {/* Custom Position X */}
      {customization.position === 'custom' && (
        <div className="customization-row">
          <div className="row-label">
            <label>{t('videoRendering.customPositionX', 'Position X')}</label>
          </div>
          <div className="row-content">
            <SliderWithValue
              value={customization.customPositionX}
              onChange={(value) => updateCustomization({ customPositionX: parseInt(value) })}
              min={0}
              max={100}
              step={1}
              orientation="horizontal"
              size="xsmall"
              state="enabled"
              className="position-x-slider"
              id="position-x-slider"
              ariaLabel={t('videoRendering.customPositionX', 'Position X')}
              formatValue={(v) => `${v}%`}
              defaultValue={defaultCustomization.customPositionX}
            />
          </div>
        </div>
      )}

      {/* Custom Position Y */}
      {customization.position === 'custom' && (
        <div className="customization-row">
          <div className="row-label">
            <label>{t('videoRendering.customPositionY', 'Position Y')}</label>
          </div>
          <div className="row-content">
            <SliderWithValue
              value={customization.customPositionY}
              onChange={(value) => updateCustomization({ customPositionY: parseInt(value) })}
              min={0}
              max={100}
              step={1}
              orientation="horizontal"
              size="xsmall"
              state="enabled"
              className="position-y-slider"
              id="position-y-slider"
              ariaLabel={t('videoRendering.customPositionY', 'Position Y')}
              formatValue={(v) => `${v}%`}
              defaultValue={defaultCustomization.customPositionY}
            />
          </div>
        </div>
      )}

      {/* Max Width */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.maxWidth', 'Max Width')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.maxWidth}
            onChange={(value) => updateCustomization({ maxWidth: parseInt(value) })}
            min={10}
            max={150}
            step={1}
            orientation="horizontal"
            size="xsmall"
            state="enabled"
            className="max-width-slider"
            id="max-width-slider"
            ariaLabel={t('videoRendering.maxWidth', 'Max Width')}
            formatValue={(v) => `${v}%`}
            defaultValue={defaultCustomization.maxWidth}
          />
        </div>
      </div>

      {/* Margin Bottom */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.marginBottom', 'Margin Bottom')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.marginBottom}
            onChange={(value) => updateCustomization({ marginBottom: parseInt(value) })}
            min={0}
            max={2000}
            step={1}
            orientation="horizontal"
            size="xsmall"
            state="enabled"
            className="margin-bottom-slider"
            id="margin-bottom-slider"
            ariaLabel={t('videoRendering.marginBottom', 'Margin Bottom')}
            formatValue={(v) => `${v}px`}
            defaultValue={defaultCustomization.marginBottom}
          />
        </div>
      </div>

      {/* Margin Top */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.marginTop', 'Margin Top')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.marginTop}
            onChange={(value) => updateCustomization({ marginTop: parseInt(value) })}
            min={0}
            max={2000}
            step={1}
            orientation="horizontal"
            size="xsmall"
            state="enabled"
            className="margin-top-slider"
            id="margin-top-slider"
            ariaLabel={t('videoRendering.marginTop', 'Margin Top')}
            formatValue={(v) => `${v}px`}
            defaultValue={defaultCustomization.marginTop}
          />
        </div>
      </div>

      {/* Margin Left */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.marginLeft', 'Margin Left')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.marginLeft}
            onChange={(value) => updateCustomization({ marginLeft: parseInt(value) })}
            min={0}
            max={2000}
            step={1}
            orientation="horizontal"
            size="xsmall"
            state="enabled"
            className="margin-left-slider"
            id="margin-left-slider"
            ariaLabel={t('videoRendering.marginLeft', 'Margin Left')}
            formatValue={(v) => `${v}px`}
            defaultValue={defaultCustomization.marginLeft}
          />
        </div>
      </div>

      {/* Margin Right */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.marginRight', 'Margin Right')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.marginRight}
            onChange={(value) => updateCustomization({ marginRight: parseInt(value) })}
            min={0}
            max={2000}
            step={1}
            orientation="horizontal"
            size="xsmall"
            state="enabled"
            className="margin-right-slider"
            id="margin-right-slider"
            ariaLabel={t('videoRendering.marginRight', 'Margin Right')}
            formatValue={(v) => `${v}px`}
            defaultValue={defaultCustomization.marginRight}
          />
        </div>
      </div>


    </>
  );
};

export default PositionControls;
