import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../common/SliderWithValue';
import {
  getFontSupportFlags,
  getFontWeightOptions,
  groupFontsByCategory,
} from './fontOptions';
import FontSelectionModal from './FontSelectionModal';
import { formatDecimal } from '../../utils/formatUtils';
import CustomDropdown from '../common/CustomDropdown';
import { defaultCustomization } from '../SubtitleCustomizationPanel';
import {
  currentFontSelection,
  selectableFontWeights,
  systemFontProbe,
} from '../../services/selectableFonts';
import ColorControl from './ColorControl';
import { patchSubtitleCustomization } from './customizationUpdate';
import { useFontReadiness } from '../../services/useFontReadiness';

const TextControls = ({ customization, onChange }) => {
  const { t } = useTranslation();
  const [isFontModalOpen, setIsFontModalOpen] = useState(false);
  const fontCapability = useFontReadiness();
  const fontCatalog = useMemo(() => Object.values(groupFontsByCategory()).flat(), []);
  const isSystemFaceInstalled = useMemo(() => systemFontProbe(), []);
  const selection = currentFontSelection(fontCatalog, {
    fontFamily: customization.fontFamily,
    fontWeight: customization.fontWeight,
    capability: fontCapability,
    isSystemFaceInstalled,
  });
  const exactFontWeights = selectableFontWeights({
    fontFamily: customization.fontFamily,
    capability: fontCapability,
    isSystemFaceInstalled,
  });
  const exactWeightSet = new Set(exactFontWeights);
  const fontWeightOptions = getFontWeightOptions(t).filter(({ value }) => exactWeightSet.has(value));
  const currentFont = selection.displayOption;
  const currentFontName = selection.displayName
    ?? t('fontModal.selectFont', 'Select Font');

  const updateCustomization = (updates) => {
    onChange(patchSubtitleCustomization(updates));
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
            className={`font-selector-button ${selection.selectedResolution.status === 'exact' ? '' : 'font-unavailable'}`.trim()}
            data-font-selection-status={selection.selectedResolution.status}
            onClick={() => setIsFontModalOpen(true)}
          >
            <div className="font-selector-preview">
              <span
                className="font-name"
                style={{ fontFamily: customization.fontFamily }}
              >
                {currentFontName}
              </span>
              <span className="font-flags" style={{ fontFamily: customization.fontFamily }}>
                {currentFont ? getFontSupportFlags(currentFont) : ''}
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
          <CustomDropdown
            id="font-weight-slider"
            value={customization.fontWeight}
            onChange={(value) => updateCustomization({ fontWeight: Number(value) })}
            options={fontWeightOptions}
            className="font-weight-slider"
            dataSetting="font-weight"
            ariaLabel={t('videoRendering.fontWeight', 'Font Weight')}
            placeholder={t('subtitleSettings.selectFontWeight', 'Select Font Weight')}
          />
        </div>
      </div>

      {/* Text Color */}
      <div className="customization-row">
        <div className="row-label">
          <label htmlFor="subtitle-text-color">
            {t('videoRendering.textColor', 'Text Color')}
          </label>
        </div>
        <div className="row-content">
          <ColorControl
            id="subtitle-text-color"
            value={customization.textColor}
            onChange={value => updateCustomization({ textColor: value })}
            placeholder="#ffffff"
            ariaLabel={t('videoRendering.textColor', 'Text Color')}
          />
        </div>
      </div>

      {/* Text Alignment */}
      <div className="customization-row">
        <div className="row-label">
          <label htmlFor="render-text-align">{t('videoRendering.textAlign', 'Text Alignment')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            id="render-text-align"
            value={customization.textAlign}
            onChange={(value) => updateCustomization({ textAlign: value })}
            options={[
              { value: 'left', label: t('videoRendering.left', 'Left') },
              { value: 'center', label: t('videoRendering.center', 'Center') },
              { value: 'right', label: t('videoRendering.right', 'Right') },
              { value: 'justify', label: t('videoRendering.justify', 'Justify') }
            ]}
            dataSetting="text-align"
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
          <label htmlFor="render-text-transform">{t('videoRendering.textTransform', 'Text Transform')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            id="render-text-transform"
            value={customization.textTransform}
            onChange={(value) => updateCustomization({ textTransform: value })}
            options={[
              { value: 'none', label: t('videoRendering.none', 'None') },
              { value: 'uppercase', label: t('videoRendering.uppercase', 'Uppercase') },
              { value: 'lowercase', label: t('videoRendering.lowercase', 'Lowercase') },
              { value: 'capitalize', label: t('videoRendering.capitalize', 'Capitalize') }
            ]}
            dataSetting="text-transform"
            placeholder={t('videoRendering.selectTransform', 'Select Transform')}
          />
        </div>
      </div>

      {/* Font Modal */}
      {isFontModalOpen && (
        <FontSelectionModal
          isOpen={isFontModalOpen}
          onClose={() => setIsFontModalOpen(false)}
          onFontSelect={(fontFamily, resolvedWeight) => {
            updateCustomization({
              fontFamily,
              ...(Number.isInteger(resolvedWeight) ? { fontWeight: resolvedWeight } : {}),
            });
            setIsFontModalOpen(false);
          }}
          selectedFont={customization.fontFamily}
          fontWeight={customization.fontWeight}
        />
      )}
    </>
  );
};

export default TextControls;
