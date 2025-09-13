import React from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';

/**
 * Position Settings component
 * 
 * @param {Object} props - Component props
 * @param {Object} props.settings - Current subtitle settings
 * @param {Function} props.handleSettingChange - Function to handle setting changes
 * @returns {JSX.Element} - Rendered component
 */
const PositionSettings = ({ settings, handleSettingChange }) => {
  const { t } = useTranslation();

  return (
    <>
      <div className="setting-group">
        <label htmlFor="position">{t('subtitleSettings.position', 'Y Position')}</label>
        <SliderWithValue
          value={settings.position}
          onChange={(value) => handleSettingChange('position', value)}
          min={0}
          max={100}
          step={1}
          orientation="horizontal"
          size="xsmall"
          state="enabled"
          className="position-slider"
          id="position"
          ariaLabel={t('subtitleSettings.position', 'Y Position')}
          formatValue={(v) => `${v}%`}
        />
        <div className="position-labels">
          <span>{t('subtitleSettings.top', 'Top')}</span>
          <span>{t('subtitleSettings.bottom', 'Bottom')}</span>
        </div>
      </div>

      <div className="setting-group">
        <label htmlFor="box-width">{t('subtitleSettings.boxWidth', 'Box Width')}</label>
        <SliderWithValue
          value={parseInt(settings.boxWidth)}
          onChange={(value) => handleSettingChange('boxWidth', value.toString())}
          min={50}
          max={100}
          step={5}
          orientation="Horizontal"
          size="XSmall"
          state="Enabled"
          className="box-width-slider"
          id="box-width"
          ariaLabel={t('subtitleSettings.boxWidth', 'Box Width')}
          formatValue={(v) => `${v}%`}
        />
      </div>

      <div className="setting-group">
        <label htmlFor="background-radius">{t('subtitleSettings.backgroundRadius', 'Background Radius')}</label>
        <SliderWithValue
          value={parseFloat(settings.backgroundRadius || '0')}
          onChange={(value) => handleSettingChange('backgroundRadius', value.toString())}
          min={0}
          max={20}
          step={1}
          orientation="Horizontal"
          size="XSmall"
          state="Enabled"
          className="background-radius-slider"
          id="background-radius"
          ariaLabel={t('subtitleSettings.backgroundRadius', 'Background Radius')}
          formatValue={(v) => `${v}px`}
        />
      </div>

      <div className="setting-group">
        <label htmlFor="background-padding">{t('subtitleSettings.backgroundPadding', 'Background Padding')}</label>
        <SliderWithValue
          value={parseFloat(settings.backgroundPadding || '10')}
          onChange={(value) => handleSettingChange('backgroundPadding', value.toString())}
          min={0}
          max={30}
          step={2}
          orientation="Horizontal"
          size="XSmall"
          state="Enabled"
          className="background-padding-slider"
          id="background-padding"
          ariaLabel={t('subtitleSettings.backgroundPadding', 'Background Padding')}
          formatValue={(v) => `${v}px`}
        />
      </div>
    </>
  );
};

export default PositionSettings;
