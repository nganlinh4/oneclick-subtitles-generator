import React from 'react';
import StandardSlider from './StandardSlider';

/**
 * SliderWithValue - reusable wrapper for StandardSlider with value display and reset button
 *
 * Props:
 * - value: number
 * - onChange: (value:number|string) => void
 * - defaultValue?: number|string
 * - formatValue?: (value:number|string) => React.ReactNode
 * - className?: string (applied to inner StandardSlider)
 * - children?: ReactNode (rendered to the right inside the container, e.g., help icon)
 * - All other StandardSlider props are forwarded
 */
export default function SliderWithValue({
  value,
  onChange,
  defaultValue,
  formatValue = (v) => v,
  className,
  children,
  state,
  ...sliderProps
}) {
  const globalDefault = (typeof window !== 'undefined' && window.SLIDER_DEFAULTS && sliderProps.id && Object.prototype.hasOwnProperty.call(window.SLIDER_DEFAULTS, sliderProps.id))
    ? window.SLIDER_DEFAULTS[sliderProps.id]
    : undefined;
  const resolvedDefault = (defaultValue ?? globalDefault ?? (typeof sliderProps.min !== 'undefined' ? sliderProps.min : 0));
  const resolvedState = state || sliderProps.state || 'Enabled';

  const handleReset = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof onChange === 'function') onChange(resolvedDefault);
  };

  return (
    <div
      className="slider-with-value"
      data-reset-handler-managed="true"
      data-default-value={String(resolvedDefault)}
    >
      <StandardSlider
        value={value}
        onChange={onChange}
        state={resolvedState}
        showValueIndicator={false}
        showIcon={false}
        showStops={false}
        className={className}
        {...sliderProps}
      />
      <div className="slider-value-display" title="Reset to default">
        {formatValue(value)}
        <button
          type="button"
          className="slider-reset-btn"
          aria-label="Reset to default"
          onClick={handleReset}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '14px', fontVariationSettings: "'FILL' 0, 'wght' 300, 'GRAD' 200, 'opsz' 24" }}>refresh</span>
        </button>
      </div>
      {children}
    </div>
  );
}

