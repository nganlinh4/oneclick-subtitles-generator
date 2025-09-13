import React from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../common/SliderWithValue';

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
            <div
              className="help-icon-container"
              title={t('translation.restTimeHelp', 'Adds a delay between translation requests to help avoid exceeding Gemini\'s RPM (requests per minute) limits. Useful when your translations work well at the beginning but fail towards the end due to rate limiting.')}
            >
              <svg className="help-icon" viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" strokeWidth="2" fill="none">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </div>
          </SliderWithValue>
        </div>
      </div>
    </div>
  );
};

export default RestTimeSlider;
