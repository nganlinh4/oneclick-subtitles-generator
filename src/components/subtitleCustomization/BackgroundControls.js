import { useTranslation } from 'react-i18next';
import SliderWithValue from '../common/SliderWithValue';
import CustomDropdown from '../common/CustomDropdown';
import { defaultCustomization } from '../SubtitleCustomizationPanel';
import ColorControl from './ColorControl';
import { patchSubtitleCustomization } from './customizationUpdate';

const BackgroundControls = ({ customization, onChange }) => {
  const { t } = useTranslation();

  const updateCustomization = (updates) => {
    // Sliders publish on a short timer while a drag is in flight. Applying their field patch to
    // the latest scene prevents an older callback from restoring every other field it captured
    // before (most visibly a colour committed while another control was settling).
    onChange(patchSubtitleCustomization(updates));
  };

  return (
    <>
      {/* Background Color */}
      <div className="customization-row">
        <div className="row-label">
          <label htmlFor="subtitle-background-color">
            {t('videoRendering.backgroundColor', 'Background Color')}
          </label>
        </div>
        <div className="row-content">
          <ColorControl
            id="subtitle-background-color"
            value={customization.backgroundColor}
            onChange={value => updateCustomization({ backgroundColor: value })}
            placeholder="#000000"
            ariaLabel={t('videoRendering.backgroundColor', 'Background Color')}
          />
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
          <label htmlFor="subtitle-border-color">
            {t('videoRendering.borderColor', 'Border Color')}
          </label>
        </div>
        <div className="row-content">
          <ColorControl
            id="subtitle-border-color"
            value={customization.borderColor}
            onChange={value => updateCustomization({ borderColor: value })}
            placeholder="#ffffff"
            ariaLabel={t('videoRendering.borderColor', 'Border Color')}
          />
        </div>
      </div>

      {/* Border Style */}
      <div className="customization-row">
        <div className="row-label">
          <label htmlFor="subtitle-border-style">{t('videoRendering.borderStyle', 'Border Style')}</label>
        </div>
        <div className="row-content">
          <CustomDropdown
            id="subtitle-border-style"
            value={customization.borderStyle}
            onChange={(value) => updateCustomization({ borderStyle: value })}
            options={[
              { value: 'none', label: t('videoRendering.none', 'None') },
              { value: 'solid', label: t('videoRendering.solid', 'Solid') },
              { value: 'dashed', label: t('videoRendering.dashed', 'Dashed') },
              { value: 'dotted', label: t('videoRendering.dotted', 'Dotted') },
              { value: 'double', label: t('videoRendering.double', 'Double') }
            ]}
            dataSetting="border-style"
            placeholder={t('videoRendering.selectBorderStyle', 'Select Border Style')}
          />
        </div>
      </div>
    </>
  );
};

export default BackgroundControls;
