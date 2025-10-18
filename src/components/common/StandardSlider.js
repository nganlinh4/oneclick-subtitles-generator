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
  const rafIdRef = useRef(null);
  const pendingChangeRef = useRef(null);
  const throttleTimeoutRef = useRef(null);
  const [dragValue, setDragValue] = useState(null);
  const [activeThumb, setActiveThumb] = useState(null); // 'start', 'end', or null
  const [isAnimatingSnap, setIsAnimatingSnap] = useState(false);

  const isRange = range && Array.isArray(value) && value.length === 2;
  const isVertical = orientation?.toLowerCase() === 'vertical';
  const [valueStart, valueEnd] = isRange ? value : [min, value];

  const resolvedProps = {
    width,
    orientation,
    size,
    state,
    ...figmaProps
  };
  const isDisabled = String(state || resolvedProps.state || '').toLowerCase() === 'disabled';

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

  const inactiveStartFlex = percentageStart;
  const activeFlex = percentageEnd - percentageStart;
  const inactiveEndFlex = 100 - percentageEnd;

  const shouldHideStartStop = percentageStart < 15;
  const shouldHideEndStop = percentageEnd > 85;

  const snapToStep = useCallback((val) => {
    const snapped = Math.round((val - min) / step) * step + min;
    return Math.max(min, Math.min(max, snapped));
  }, [min, max, step]);

  const pixelToValue = useCallback((coord) => {
    const trackContainer = trackRef.current;
    if (!trackContainer) return isRange ? [valueStart, valueEnd] : value;
    const rect = trackContainer.getBoundingClientRect();

    let pos;
    if (isVertical) {
      // For vertical slider, 0 is at the bottom, 1 is at the top
      pos = Math.max(0, Math.min(1, (rect.bottom - coord.clientY) / rect.height));
    } else {
      pos = Math.max(0, Math.min(1, (coord.clientX - rect.left) / rect.width));
    }
    return min + pos * (max - min);
  }, [min, max, value, valueStart, valueEnd, isRange, isVertical]);

  const handleSmoothDrag = useCallback((coord) => {
    if (!activeThumb) return;

    // Throttle UI computation to one per animation frame to keep UI smooth
    if (rafIdRef.current) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;

      let newValue = pixelToValue(coord);

      if (isRange) {
        if (activeThumb === 'start') {
          newValue = Math.min(newValue, valueEnd - minGap);
        } else {
          newValue = Math.max(newValue, valueStart + minGap);
        }
      }

      // Update only the visual drag value for immediate feedback
      setDragValue(newValue);

      // Throttle the external onChange to avoid lag (emit snapped value periodically)
      if (onChange) {
        const currentStepValue = snapToStep(newValue);
        const cleanValue = step < 1 ? parseFloat(currentStepValue.toFixed(2)) : Math.round(currentStepValue);

        // Store the pending value; a timeout will emit it shortly
        if (isRange) {
          pendingChangeRef.current = activeThumb === 'start' ? [cleanValue, valueEnd] : [valueStart, cleanValue];
        } else {
          pendingChangeRef.current = cleanValue;
        }

        if (!throttleTimeoutRef.current) {
          throttleTimeoutRef.current = setTimeout(() => {
            throttleTimeoutRef.current = null;
            if (pendingChangeRef.current !== null) {
              onChange(pendingChangeRef.current);
            }
          }, 75);
        }
      }
    });
  }, [activeThumb, pixelToValue, snapToStep, onChange, step, valueStart, valueEnd, minGap, isRange]);

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

  const handleDragStart = useCallback((e, thumbIdentifier) => {
    if (isDisabled) return;
    e.preventDefault();
    e.stopPropagation();

    const coord = e.type.includes('touch')
      ? { clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }
      : { clientX: e.clientX, clientY: e.clientY };

    const initialValue = pixelToValue(coord);

    let thumbToActivate = thumbIdentifier;
    if (isRange && !thumbToActivate) {
      const distToStart = Math.abs(initialValue - valueStart);
      const distToEnd = Math.abs(initialValue - valueEnd);
      thumbToActivate = distToStart <= distToEnd ? 'start' : 'end';
    } else if (!isRange) {
        thumbToActivate = 'end';
    }

    // Prevent text selection while dragging
    if (document && document.body) document.body.style.userSelect = 'none';

    setActiveThumb(thumbToActivate);
    setIsDragging(true);
    setIsAnimatingSnap(false);
    setDragValue(initialValue);
    if (onDragStart) onDragStart();
  }, [pixelToValue, onDragStart, isDisabled, isRange, valueStart, valueEnd]);

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;

    // Clear any pending animation frame and throttles
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (throttleTimeoutRef.current) {
      clearTimeout(throttleTimeoutRef.current);
      throttleTimeoutRef.current = null;
    }

    setIsDragging(false);

    // Restore text selection
    if (document && document.body) document.body.style.userSelect = '';

    // Compute and emit final snapped value synchronously
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

      // Reset transient drag state after the snap animation
      setTimeout(() => {
        setDragValue(null);
        setIsAnimatingSnap(false);
        setActiveThumb(null);
        pendingChangeRef.current = null;
      }, 120);
    } else {
      // No drag value; just reset state
      setActiveThumb(null);
      pendingChangeRef.current = null;
    }

    if (onDragEnd) onDragEnd();
  }, [isDragging, dragValue, snapToStep, onChange, onDragEnd, isRange, activeThumb, valueStart, valueEnd]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || isDisabled) return;

    const handleMouseMove = (e) => { if (isDragging) handleSmoothDrag({ clientX: e.clientX, clientY: e.clientY }); };
    const handleTouchMove = (e) => { if (isDragging && e.touches.length > 0) handleSmoothDrag({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY }); };
    const handleUp = () => { if (isDragging) handleDragEnd(); };
    const handleVisibility = () => { if (document.hidden) handleUp(); };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleUp);
    window.addEventListener('mouseup', handleUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleUp);
    document.addEventListener('touchcancel', handleUp);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleUp);
      window.removeEventListener('mouseup', handleUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleUp);
      document.removeEventListener('touchcancel', handleUp);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleUp);
    };
  }, [isDragging, handleDragEnd, handleSmoothDrag, isDisabled]);

  const containerClasses = [
    'standard-slider-container',
    `width-${resolvedProps.width}`,
    `orientation-${resolvedProps.orientation?.toLowerCase()}`,
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

  const trackContainerStyle = {
    touchAction: 'none',
  };
  if (isVertical) {
      // For vertical, we stack them bottom-to-top
      trackContainerStyle.flexDirection = 'column-reverse';
  }

  const getTrackStyle = (flexVal) => ({
    flexGrow: flexVal / 100,
    ...(isVertical ? { minHeight: 0 } : { minWidth: 0 }),
  });


  return (
    <div ref={containerRef} className={containerClasses} {...props}>
      <div
        ref={trackRef}
        className="standard-slider-track-container"
        style={trackContainerStyle}
        onMouseDown={(e) => {
          // Only start drag on primary button
          if (e.button !== 0) return;
          handleDragStart(e);
        }}
        onTouchStart={(e) => {
          // Do not start dragging on touchstart to avoid conflicts with reveal gestures
          // Let touchmove initiate dragging when the user actually moves
          // Prevent this event from bubbling to parent reveal handlers if coming from handle
          e.stopPropagation();
        }}
        onTouchMove={(e) => {
          // Start drag on first movement to avoid accidental activation when revealing the pill
          if (!isDragging) {
            handleDragStart(e);
          }
        }}
      >
        {!isRange ? (
          <>
            <div
              className="standard-slider-active-track"
              style={{ flexGrow: activeFlex / 100 }}
            >
              <div className="track"></div>
            </div>
            <div className="standard-slider-handle" onMouseDown={(e) => handleDragStart(e, 'end')}>
              {showValueBadge && isDragging && renderValueBadge(currentValueEnd)}
            </div>
            <div
              className="standard-slider-inactive-track"
              style={{ flexGrow: inactiveEndFlex / 100 }}
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
              style={getTrackStyle(inactiveStartFlex)}
            >
              <div className={`standard-slider-start-stop ${shouldHideStartStop ? 'hidden' : ''}`}></div>
              <div className="track start"></div>
            </div>
            <div className="standard-slider-handle handle-start" onMouseDown={(e) => handleDragStart(e, 'start')}>
              {showValueBadge && isDragging && activeThumb === 'start' && renderValueBadge(currentValueStart)}
            </div>
            <div
              className="standard-slider-active-track"
              style={getTrackStyle(activeFlex)}
            >
              <div className="track range"></div>
            </div>
            <div className="standard-slider-handle handle-end" onMouseDown={(e) => handleDragStart(e, 'end')}>
              {showValueBadge && isDragging && activeThumb === 'end' && renderValueBadge(currentValueEnd)}
            </div>
            <div
              className="standard-slider-inactive-track"
              style={getTrackStyle(inactiveEndFlex)}
            >
              <div className="track end"></div>
              <div className={`standard-slider-end-stop ${shouldHideEndStop ? 'hidden' : ''}`}></div>
            </div>
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