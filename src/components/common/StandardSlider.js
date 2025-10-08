import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Component property mapping system for Figma variants
 */
const FIGMA_COMPONENT_PROPERTIES = {
  // ... (no changes here)
};

/**
 * StandardSlider component based on Figma design
 * Implements the Standard slider component with all variants and properties
 * Matches Figma component: "Standard slider" with variants and properties
 *
 * @param {Object} props - Component props
 * @param {number | [number, number]} props.value - Current slider value. A single number for a standard slider, or an array [start, end] for a range slider.
 * @param {Function} props.onChange - Callback when value changes. Returns a number or an array [start, end].
 * @param {boolean} props.range - Set to true to enable range slider mode (default: false)
 * @param {number} props.minGap - Minimum gap between start and end values for range slider (default: 1)
 * @param {number} props.min - Minimum value (default: 0)
 * @param {number} props.max - Maximum value (default: 100)
 * @param {number} props.step - Step increment (default: 1)
 * @param {string} props.orientation - 'horizontal' or 'vertical' (default: 'horizontal')
 * @param {string} props.size - 'xsmall', 'small', 'medium', 'large' (default: 'xsmall')
 * @param {string} props.state - 'enabled', 'disabled', 'hover', 'focus' (default: 'enabled')
 * @param {string} props.width - 'auto', 'full', 'compact' (default: 'auto')
 * @param {boolean} props.showValueIndicator - Show value display (default: true)
 * @param {boolean} props.showIcon - Show icon (default: false)
 * @param {boolean} props.showStops - Show track stops (default: false)
 * @param {boolean} props.enableWheel - Enable mouse wheel to adjust value (default: true)
 * @param {number} props.wheelStepMultiplier - Multiplies step per wheel tick (default: 1)
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.id - Input ID for accessibility
 * @param {string} props.ariaLabel - Aria label for accessibility
 * @param {Function} props.onDragStart - Callback when dragging starts
 * @param {Function} props.onDragEnd - Callback when dragging ends
 * @param {Object} props.figmaProps - Direct Figma component properties override
 * @returns {JSX.Element} - Rendered StandardSlider component
 */
const StandardSlider = ({
  value = 50, // Figma default for single, or provide [25, 75] for range
  onChange,
  range = false,
  minGap = 1,
  min = 0,
  max = 100,
  step = 1,
  orientation = 'Horizontal',
  size = 'XSmall',
  state = 'Enabled',
  width = 'auto',
  showValueIndicator = true,
  showIcon = false,
  showStops = false,
  showValueBadge = true,
  valueBadgeFormatter,
  enableWheel = true,
  wheelStepMultiplier = 1,
  className = '',
  id,
  ariaLabel,
  onDragStart,
  onDragEnd,
  figmaProps = {},
  ...props
}) => {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const trackRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState(null);
  const [activeThumb, setActiveThumb] = useState(null); // 'start', 'end', or null
  const [isAnimatingSnap, setIsAnimatingSnap] = useState(false);
  const [lastStepValue, setLastStepValue] = useState(null);

  const isRange = range && Array.isArray(value) && value.length === 2;
  const [valueStart, valueEnd] = isRange ? value : [min, value];
  
  const resolvedProps = { /* ... (no changes here) */ };
  const isDisabled = String(resolvedProps.state).toLowerCase() === 'disabled';

  // Calculate percentages from resolved values or drag values for smooth movement
  const getCurrentValue = (thumb) => {
    if (isDragging && activeThumb === thumb && dragValue !== null) {
      return dragValue;
    }
    return thumb === 'start' ? valueStart : valueEnd;
  };

  const currentValueStart = getCurrentValue('start');
  const currentValueEnd = getCurrentValue('end');

  const percentageStart = ((currentValueStart - min) / (max - min)) * 100;
  const percentageEnd = ((currentValueEnd - min) / (max - min)) * 100;

  // Calculate flex-grow for layout
  const inactiveStartFlex = percentageStart / 100;
  const activeFlex = (percentageEnd - percentageStart) / 100;
  const inactiveEndFlex = (100 - percentageEnd) / 100;
  
  // Logic to hide stops when thumb is too close to avoid visual overlap
  const shouldHideStartStop = percentageStart < 15;
  const shouldHideEndStop = percentageEnd > 85;

  const snapToStep = useCallback((val) => {
    const snapped = Math.round((val - min) / step) * step + min;
    return Math.max(min, Math.min(max, snapped));
  }, [min, max, step]);

  const pixelToValue = useCallback((clientX) => {
    const trackContainer = trackRef.current;
    if (!trackContainer) return isRange ? [valueStart, valueEnd] : value;
    const rect = trackContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return min + pos * (max - min);
  }, [min, max, value, valueStart, valueEnd, isRange]);

  const handleSmoothDrag = useCallback((clientX) => {
    if (!activeThumb) return;

    let newValue = pixelToValue(clientX);
    
    // Enforce minGap for range sliders
    if (isRange) {
      if (activeThumb === 'start') {
        newValue = Math.min(newValue, valueEnd - minGap);
      } else { // activeThumb === 'end'
        newValue = Math.max(newValue, valueStart + minGap);
      }
    }
    
    setDragValue(newValue);
    const currentStepValue = snapToStep(newValue);

    if (Math.abs(currentStepValue - (lastStepValue || (activeThumb === 'start' ? valueStart : valueEnd))) > 0.001 && onChange) {
      setLastStepValue(currentStepValue);
      const cleanValue = step < 1 ? parseFloat(currentStepValue.toFixed(2)) : Math.round(currentStepValue);
      
      if (isRange) {
        onChange(activeThumb === 'start' ? [cleanValue, valueEnd] : [valueStart, cleanValue]);
      } else {
        onChange(cleanValue);
      }
    }
  }, [activeThumb, pixelToValue, snapToStep, lastStepValue, onChange, step, value, valueStart, valueEnd, minGap, isRange]);
  
  const handleChange = (e, thumb) => {
    const newValue = parseFloat(e.target.value);
    if (!onChange) return;
    
    if (isRange) {
      const newRange = thumb === 'start' ? [newValue, valueEnd] : [valueStart, newValue];
      onChange(newRange);
    } else {
      onChange(newValue);
    }
  };

  const getFigmaComponentName = () => { /* ... (no changes here) */ };
  
  const handleDragStart = useCallback((e, thumbIdentifier) => {
    if (isDisabled) return;
    e.preventDefault();
    e.stopPropagation();

    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const initialValue = pixelToValue(clientX);

    let thumbToActivate = thumbIdentifier;
    if (isRange && !thumbToActivate) {
      // If track is clicked directly, find the closest thumb
      const distToStart = Math.abs(initialValue - valueStart);
      const distToEnd = Math.abs(initialValue - valueEnd);
      thumbToActivate = distToStart <= distToEnd ? 'start' : 'end';
    } else if (!isRange) {
        thumbToActivate = 'end'; // Single slider thumb is equivalent to 'end'
    }

    setActiveThumb(thumbToActivate);
    setIsDragging(true);
    setIsAnimatingSnap(false);
    setDragValue(initialValue);
    setLastStepValue(thumbToActivate === 'start' ? valueStart : valueEnd);
    if (onDragStart) onDragStart();
  }, [pixelToValue, onDragStart, isDisabled, isRange, valueStart, valueEnd]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    
    setIsDragging(false);
    setLastStepValue(null);

    if (dragValue !== null) {
      const snappedValue = snapToStep(dragValue);
      setIsAnimatingSnap(true);

      if (onChange) {
        if (isRange) {
            const finalStart = activeThumb === 'start' ? snappedValue : valueStart;
            const finalEnd = activeThumb === 'end' ? snappedValue : valueEnd;
            onChange([finalStart, finalEnd]);
        } else {
            onChange(snappedValue);
        }
      }

      setTimeout(() => {
        setDragValue(null);
        setIsAnimatingSnap(false);
        setActiveThumb(null);
      }, 200);
    }

    if (onDragEnd) onDragEnd();
  }, [dragValue, snapToStep, onChange, onDragEnd, isRange, activeThumb, valueStart, valueEnd, isDragging]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || isDisabled) return;

    const handleMouseMove = (e) => { if (isDragging) handleSmoothDrag(e.clientX); };
    const handleTouchMove = (e) => { if (isDragging && e.touches.length > 0) handleSmoothDrag(e.touches[0].clientX); };
    const handleMouseUp = () => { if (isDragging) handleDragEnd(); };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleMouseUp);
    };
  }, [isDragging, handleDragEnd, handleSmoothDrag, isDisabled]);

  const containerClasses = [
    'standard-slider-container',
    `width-${resolvedProps.width}`,
    `orientation-${resolvedProps.orientation}`,
    `size-${resolvedProps.size}`,
    `state-${resolvedProps.state}`,
    isDisabled ? 'disabled' : '',
    isDragging ? 'dragging' : '',
    isAnimatingSnap ? 'snapping' : '',
    isRange ? 'range-slider' : '',
    className,
  ].filter(Boolean).join(' ');
  
  const renderValueBadge = (val) => (
    <div className="standard-slider-value-badge">
      {valueBadgeFormatter
        ? valueBadgeFormatter(val)
        : step < 1 ? parseFloat(parseFloat(val).toFixed(2)) : Math.round(val)}
    </div>
  );

  return (
    <div ref={containerRef} className={containerClasses} {...props}>
      <div 
        ref={trackRef} 
        className="standard-slider-track-container"
        style={{ touchAction: 'none' }}
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
      >
        {!isRange ? (
          <>
            <div
              className="standard-slider-active-track"
              style={{
                flexGrow: activeFlex
              }}
            >
              <div className="track"></div>
            </div>
            <div className="standard-slider-handle" onMouseDown={(e) => handleDragStart(e, 'end')}>
              {showValueBadge && isDragging && renderValueBadge(currentValueEnd)}
            </div>
            <div
              className="standard-slider-inactive-track"
              style={{
                flexGrow: inactiveEndFlex
              }}
            >
              <div className="track"></div>
              <div className={`standard-slider-end-stop ${shouldHideEndStop ? 'hidden' : ''}`}></div>
            </div>
            <input type="range" min={min} max={max} step={step} value={valueEnd} onChange={handleChange} className="standard-slider-input" id={id} aria-label={ariaLabel || t('common.slider', 'Slider')} disabled={isDisabled} tabIndex={-1} style={{ pointerEvents: 'none' }} />
          </>
        ) : (
          <>
            <div
              className="standard-slider-inactive-track"
              style={{
                flexGrow: inactiveStartFlex,
                minWidth: 0,
                height: isRange ? 'var(--standard-slider-inactive-track-height, 8px)' : undefined
              }}
            >
              <div className={`standard-slider-start-stop ${shouldHideStartStop ? 'hidden' : ''}`}></div>
              <div className="track start"></div>
            </div>
            <div className="standard-slider-handle handle-start" onMouseDown={(e) => handleDragStart(e, 'start')}>
              {showValueBadge && isDragging && activeThumb === 'start' && renderValueBadge(currentValueStart)}
            </div>
            <div
              className="standard-slider-active-track"
              style={{
                flexGrow: activeFlex,
                minWidth: 0,
                height: isRange ? 'var(--standard-slider-active-track-height, 8px)' : undefined
              }}
            >
              <div className="track range"></div>
            </div>
            <div className="standard-slider-handle handle-end" onMouseDown={(e) => handleDragStart(e, 'end')}>
              {showValueBadge && isDragging && activeThumb === 'end' && renderValueBadge(currentValueEnd)}
            </div>
            <div
              className="standard-slider-inactive-track"
              style={{
                flexGrow: inactiveEndFlex,
                minWidth: 0,
                height: isRange ? 'var(--standard-slider-inactive-track-height, 8px)' : undefined
              }}
            >
              <div className="track end"></div>
              <div className={`standard-slider-end-stop ${shouldHideEndStop ? 'hidden' : ''}`}></div>
            </div>
            {/* Accessibility inputs for range slider */}
            <input type="range" min={min} max={max} step={step} value={valueStart} onChange={(e) => handleChange(e, 'start')} className="standard-slider-input" aria-label={ariaLabel ? `${ariaLabel} start` : t('common.sliderStart', 'Slider start')} disabled={isDisabled} tabIndex={-1} style={{ pointerEvents: 'none' }} />
            <input type="range" min={min} max={max} step={step} value={valueEnd} onChange={(e) => handleChange(e, 'end')} className="standard-slider-input" aria-label={ariaLabel ? `${ariaLabel} end` : t('common.sliderEnd', 'Slider end')} disabled={isDisabled} tabIndex={-1} style={{ pointerEvents: 'none' }} />
          </>
        )}
      </div>
      {showValueIndicator && (
        <div className="standard-slider-value-indicator">
          {isRange ? `${Math.round(valueStart)}-${Math.round(valueEnd)}%` : `${Math.round(valueEnd)}%`}
        </div>
      )}
    </div>
  );
};

export default StandardSlider;