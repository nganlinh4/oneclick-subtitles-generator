import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import StandardSlider from '../common/StandardSlider';
import SliderWithValue from '../common/SliderWithValue';
import { groupFontsByCategory, getFontSupportFlags } from './fontOptions';
import FontSelectionModal from './FontSelectionModal';
import { formatDecimal } from '../../utils/formatUtils';
import CustomDropdown from '../common/CustomDropdown';
import { defaultCustomization } from '../SubtitleCustomizationPanel';

const TextControls = ({ customization, onChange }) => {
  const { t } = useTranslation();
  const [isFontModalOpen, setIsFontModalOpen] = useState(false);

  const updateCustomization = (updates) => {
    onChange({ ...customization, ...updates, preset: 'custom' });
  };

  return (
    <>
      {/* Font Family */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.fontFamily', 'Font Family')}</label>
        </div>
        <div className="row-content">
          <button
            className="font-selector-button"
            onClick={() => setIsFontModalOpen(true)}
          >
            <div className="font-selector-preview">
              <span
                className="font-name"
                style={{ fontFamily: customization.fontFamily }}
              >
                {(() => {
                  const currentFont = Object.values(groupFontsByCategory())
                    .flat()
                    .find(font => font.value === customization.fontFamily);
                  return currentFont?.label || 'Select Font';
                })()}
              </span>
              <span className="font-flags" style={{ fontFamily: customization.fontFamily }}>
                {(() => {
                  const currentFont = Object.values(groupFontsByCategory())
                    .flat()
                    .find(font => font.value === customization.fontFamily);
                  return currentFont ? getFontSupportFlags(currentFont) : '';
                })()}
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* Font Size */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.fontSize', 'Font Size')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.fontSize}
            onChange={(value) => updateCustomization({ fontSize: parseInt(value) })}
            min={8}
            max={120}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="font-size-slider"
            id="font-size-slider"
            ariaLabel={t('videoRendering.fontSize', 'Font Size')}
            formatValue={(v) => `${v}px`}
            defaultValue={defaultCustomization.fontSize}
          />
        </div>
      </div>

      {/* Font Weight */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.fontWeight', 'Font Weight')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.fontWeight}
            onChange={(value) => updateCustomization({ fontWeight: parseInt(value) })}
            min={100}
            max={900}
            step={100}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="font-weight-slider"
            id="font-weight-slider"
            ariaLabel={t('videoRendering.fontWeight', 'Font Weight')}
            formatValue={(v) => v}
            defaultValue={defaultCustomization.fontWeight}
          />
        </div>
      </div>

      {/* Text Color */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.textColor', 'Text Color')}</label>
        </div>
        <div className="row-content">
          <div className="color-control">
            <input
              type="color"
              value={customization.textColor}
              onChange={(e) => updateCustomization({ textColor: e.target.value })}
              className="color-picker"
            />
            <input
              type="text"
              value={customization.textColor}
              onChange={(e) => updateCustomization({ textColor: e.target.value })}
              placeholder="#ffffff"
              className="color-input"
            />
          </div>
        </div>
      </div>

      {/* Text Alignment */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.textAlign', 'Text Alignment')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            value={customization.textAlign}
            onChange={(value) => updateCustomization({ textAlign: value })}
            options={[
              { value: 'left', label: t('videoRendering.left', 'Left') },
              { value: 'center', label: t('videoRendering.center', 'Center') },
              { value: 'right', label: t('videoRendering.right', 'Right') }
            ]}
            placeholder={t('videoRendering.selectAlignment', 'Select Alignment')}
          />
        </div>
      </div>

      {/* Line Height */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.lineHeight', 'Line Height')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.lineHeight}
            onChange={(value) => updateCustomization({ lineHeight: formatDecimal(value, 1) })}
            min={0.5}
            max={3.0}
            step={0.1}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="line-height-slider"
            id="line-height-slider"
            ariaLabel={t('videoRendering.lineHeight', 'Line Height')}
            formatValue={(v) => formatDecimal(v, 1)}
            defaultValue={defaultCustomization.lineHeight}
          />
        </div>
      </div>

      {/* Letter Spacing */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.letterSpacing', 'Letter Spacing')}</label>
        </div>
        <div className="row-content">
          <SliderWithValue
            value={customization.letterSpacing}
            onChange={(value) => updateCustomization({ letterSpacing: formatDecimal(value, 1) })}
            min={-10}
            max={10}
            step={0.5}
            orientation="Horizontal"
            size="XSmall"
            state="Enabled"
            className="letter-spacing-slider"
            id="letter-spacing-slider"
            ariaLabel={t('videoRendering.letterSpacing', 'Letter Spacing')}
            formatValue={(v) => `${formatDecimal(v, 1)}px`}
            defaultValue={defaultCustomization.letterSpacing}
          />
        </div>
      </div>

      {/* Text Transform */}
      <div className="customization-row">
        <div className="row-label">
          <label>{t('videoRendering.textTransform', 'Text Transform')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            value={customization.textTransform}
            onChange={(value) => updateCustomization({ textTransform: value })}
            options={[
              { value: 'none', label: t('videoRendering.none', 'None') },
              { value: 'uppercase', label: t('videoRendering.uppercase', 'Uppercase') },
              { value: 'lowercase', label: t('videoRendering.lowercase', 'Lowercase') },
              { value: 'capitalize', label: t('videoRendering.capitalize', 'Capitalize') }
            ]}
            placeholder={t('videoRendering.selectTransform', 'Select Transform')}
          />
        </div>
      </div>

      {/* Font Modal */}
      {isFontModalOpen && (
        <FontSelectionModal
          isOpen={isFontModalOpen}
          onClose={() => setIsFontModalOpen(false)}
          onFontSelect={(fontFamily) => {
            updateCustomization({ fontFamily });
            setIsFontModalOpen(false);
          }}
          selectedFont={customization.fontFamily}
        />
      )}
    </>
  );
};

export default TextControls;
