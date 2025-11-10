import React from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../common/SliderWithValue';
import HelpIcon from '../common/HelpIcon';


/**
 * Rest time slider component
 * @param {Object} props - Component props
 * @param {number} props.restTime - Current rest time value in seconds
 * @param {Function} props.onRestTimeChange - Function to handle rest time change
 * @param {boolean} props.disabled - Whether the slider is disabled
 * @returns {JSX.Element} - Rendered component
 */
const RestTimeSlider = ({ restTime, onRestTimeChange, disabled = false }) => {
  const { t } = useTranslation();

  return (
    <div className="translation-row rest-time-row">
      <div className="row-label">
        <label>{t('translation.restTime', 'Rest Time')}:</label>
      </div>
      <div className="row-content">
        {/* Slider control row with help icon */}
        <div className="slider-control-row">
          <SliderWithValue
            value={restTime}
            onChange={(value) => onRestTimeChange(parseInt(value))}
            min={0}
            max={20}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state={disabled ? "Disabled" : "Enabled"}
            className="rest-time-slider"
            id="rest-time-slider"
            ariaLabel={t('translation.restTime', 'Rest Time')}
            formatValue={(v) => v === 0 ? t('translation.noRest', 'No delay') : `${v} ${t('translation.seconds', 'sec')}`}
          >
            {/* Help icon next to slider value */}
            <HelpIcon
              title={t('translation.restTimeHelp', 'Adds a delay between translation requests to help avoid exceeding Gemini\'s RPM (requests per minute) limits. Useful when your translations work well at the beginning but fail towards the end due to rate limiting.')}
            />
          </SliderWithValue>
        </div>
      </div>
    </div>
  );
};

export default RestTimeSlider;
