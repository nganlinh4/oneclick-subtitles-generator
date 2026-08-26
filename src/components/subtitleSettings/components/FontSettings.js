import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import { formatDecimal } from '../../../utils/formatUtils';
import CustomDropdown from '../../common/CustomDropdown';

/**
 * Font Settings component
 * 
 * @param {Object} props - Component props
 * @param {Object} props.settings - Current subtitle settings
 * @param {Function} props.handleSettingChange - Function to handle setting changes
 * @param {Array} props.fontOptions - Exact renderer-backed font options
 * @param {Array} props.fontWeightOptions - Font weight options
 * @returns {JSX.Element} - Rendered component
 */
const FontSettings = ({
  settings,
  handleSettingChange,
  handleSettingsChange,
  fontOptions,
  selectedFontValue,
  fontWeightOptions,
}) => {
  const { t } = useTranslation();

  const handleFontFamilyChange = (value) => {
    const selected = fontOptions.find(option => option.value === value);
    if (!selected || !Number.isInteger(selected.resolvedWeight)) return;
    // Family and weight are one face identity. Publishing them separately creates an intermediate
    // impossible request and the first callback can be overwritten by the second callback's stale
    // settings closure.
    handleSettingsChange({
      fontFamily: selected.value,
      fontWeight: String(selected.resolvedWeight),
    });
  };

  return (
    <>
      <div className="setting-group">
        <label id="font-family-label" htmlFor="font-family">
          {t('subtitleSettings.font', 'Font')}
        </label>
        <CustomDropdown
          id="font-family"
          value={selectedFontValue}
          onChange={handleFontFamilyChange}
          options={fontOptions.map(font => ({
            value: font.value,
            label: `${font.label} ${font.koreanSupport ? '🇰🇷' : ''}${font.vietnameseSupport ? '🇻🇳' : ''}`,
          }))}
          placeholder={t('subtitleSettings.selectFont', 'Select Font')}
          dataSetting="font-family"
          ariaLabelledBy="font-family-label"
        />

      </div>

      <div className="setting-group">
        <label htmlFor="font-size">{t('subtitleSettings.fontSize', 'Font Size')}</label>
        <SliderWithValue
          value={parseInt(settings.fontSize)}
          onChange={(value) => handleSettingChange('fontSize', value.toString())}
          min={12}
          max={120}
          step={1}
          orientation="Horizontal"
          size="XSmall"
          state="Enabled"
          className="font-size-slider"
          id="font-size"
          ariaLabel={t('subtitleSettings.fontSize', 'Font Size')}
          formatValue={(v) => `${v}px`}
        />
      </div>

      <div className="setting-group">
        <label id="font-weight-label" htmlFor="font-weight">
          {t('subtitleSettings.fontWeight', 'Font Weight')}
        </label>
        <CustomDropdown
          id="font-weight"
          value={settings.fontWeight}
          onChange={(value) => handleSettingChange('fontWeight', value)}
          options={fontWeightOptions}
          dataSetting="font-weight"
          ariaLabelledBy="font-weight-label"
          placeholder={t('subtitleSettings.selectFontWeight', 'Select Font Weight')}
        />
      </div>

      <div className="setting-group">
        <label htmlFor="line-spacing">{t('subtitleSettings.lineSpacing', 'Line Spacing')}</label>
        <SliderWithValue
          value={parseFloat(settings.lineSpacing || '1.4')}
          onChange={(value) => handleSettingChange('lineSpacing', value.toString())}
          min={1}
          max={2}
          step={0.1}
          orientation="Horizontal"
          size="XSmall"
          state="Enabled"
          className="line-spacing-slider"
          id="line-spacing"
          ariaLabel={t('subtitleSettings.lineSpacing', 'Line Spacing')}
          formatValue={(v) => `${formatDecimal(Number(v), 1)}`}
        />
      </div>

      <div className="setting-group">
        <label htmlFor="letter-spacing">{t('subtitleSettings.letterSpacing', 'Letter Spacing')}</label>
        <SliderWithValue
          value={parseFloat(settings.letterSpacing || '0')}
          onChange={(value) => handleSettingChange('letterSpacing', value.toString())}
          min={-1}
          max={5}
          step={0.5}
          orientation="Horizontal"
          size="XSmall"
          state="Enabled"
          className="letter-spacing-slider"
          id="letter-spacing"
          ariaLabel={t('subtitleSettings.letterSpacing', 'Letter Spacing')}
          formatValue={(v) => `${formatDecimal(Number(v), 1)}px`}
        />
      </div>
    </>
  );
};

export default FontSettings;
