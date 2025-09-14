import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Component property mapping system for Figma variants
 */
const FIGMA_COMPONENT_PROPERTIES = {
  orientation: {
    horizontal: 'Horizontal',
    vertical: 'Vertical'
  },
  size: {
    xsmall: 'XSmall',
    small: 'Small',
    medium: 'Medium',
    large: 'Large'
  },
  state: {
    enabled: 'Enabled',
    disabled: 'Disabled',
    hover: 'Hover',
    focus: 'Focus'
  },
  value: {
    0: '0',
    25: '25',
    50: '50',
    75: '75',
    100: '100'
  }
};

/**
 * StandardSlider component based on Figma design
 * Implements the Standard slider component with all variants and properties
 * Matches Figma component: "Standard slider" with variants and properties
 *
 * @param {Object} props - Component props
 * @param {number} props.value - Current slider value (0-100)
 * @param {Function} props.onChange - Callback when value changes
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
 * @param {string} props.className - Additional CSS classes
 * @param {string} props.id - Input ID for accessibility
 * @param {string} props.ariaLabel - Aria label for accessibility
 * @param {Function} props.onDragStart - Callback when dragging starts
 * @param {Function} props.onDragEnd - Callback when dragging ends
 * @param {Object} props.figmaProps - Direct Figma component properties override
 * @returns {JSX.Element} - Rendered StandardSlider component
 */
const StandardSlider = ({
  value = 50, // Figma default
  onChange,
  min = 0,
  max = 100,
  step = 1,
  orientation = 'Horizontal', // Figma default (capitalized)
  size = 'XSmall', // Figma default (capitalized)
  state = 'Enabled', // Figma default (capitalized)
  width = 'auto', // Width variant: 'auto', 'full', 'compact'
  showValueIndicator = true, // Figma default
  showIcon = false, // Figma default
  showStops = false, // Figma default
  showValueBadge = true, // New: allow hiding the dragging value badge
  valueBadgeFormatter, // New: custom formatter for the dragging value badge
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
  const [dragValue, setDragValue] = useState(null); // Smooth drag value (can be between steps)
  const [isAnimatingSnap, setIsAnimatingSnap] = useState(false);
  const [lastStepValue, setLastStepValue] = useState(null); // Track last step value that was triggered

  // Apply Figma component properties if provided
  const resolvedProps = {
    orientation: figmaProps.Orientation || orientation,
    size: figmaProps.Size || size,
    state: figmaProps.State || state,
    width: figmaProps.Width || width, // Support Figma width variants
    showValueIndicator: figmaProps['Show value indicator'] !== undefined
      ? figmaProps['Show value indicator']
      : showValueIndicator,
    showIcon: figmaProps['Show icon'] !== undefined
      ? figmaProps['Show icon']
      : showIcon,
    showStops: figmaProps['Show stops'] !== undefined
      ? figmaProps['Show stops']
      : showStops,
    value: figmaProps.Value !== undefined
      ? parseInt(figmaProps.Value)
      : value
  };

  // Determine disabled state (case-insensitive)
  const isDisabled = String(resolvedProps.state).toLowerCase() === 'disabled';

  // Calculate percentage from resolved value or drag value for smooth movement
  const currentValue = isDragging && dragValue !== null ? dragValue : resolvedProps.value;
  const percentage = ((currentValue - min) / (max - min)) * 100;

  // Calculate active track flex-grow for Material 3 layout with gaps
  // The handle sits between tracks, so we need to account for spacing
  const activeTrackFlex = percentage / 100; // Convert percentage to flex ratio
  const inactiveTrackFlex = (100 - percentage) / 100;

  // Hide end stop when handle is close to the end (Material Design 3 behavior)
  const shouldHideEndStop = percentage > 85; // Hide when >85% to avoid visual clutter

  // Snap value to nearest step
  const snapToStep = useCallback((value) => {
    const snappedValue = Math.round((value - min) / step) * step + min;
    return Math.max(min, Math.min(max, snappedValue));
  }, [min, max, step]);

  // Convert pixel position to value
  const pixelToValue = useCallback((clientX) => {
    const container = containerRef.current;
    if (!container) return resolvedProps.value;

    const trackContainer = container.querySelector('.standard-slider-track-container');
    if (!trackContainer) return resolvedProps.value;

    const rect = trackContainer.getBoundingClientRect();
    const percentage = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return min + percentage * (max - min);
  }, [min, max, resolvedProps.value]);

  // Handle smooth drag movement
  const handleSmoothDrag = useCallback((clientX) => {
    const newValue = pixelToValue(clientX);
    setDragValue(newValue);

    // Calculate the current step value that the drag position represents
    const currentStepValue = snapToStep(newValue);

    // Only trigger onChange if we've moved to a different step value
    // Use a small epsilon for floating point comparison
    const epsilon = step < 1 ? 0.001 : 0.1;
    if (Math.abs(currentStepValue - (lastStepValue || resolvedProps.value)) > epsilon && onChange) {
      setLastStepValue(currentStepValue);
      // Clean up floating point precision issues before calling onChange
      const cleanValue = step < 1 ? parseFloat(currentStepValue.toFixed(2)) : Math.round(currentStepValue);
      onChange(cleanValue);
    }
  }, [pixelToValue, snapToStep, lastStepValue, onChange, step, resolvedProps.value]);

  // Handle value change (for native input fallback)
  const handleChange = (e) => {
    const newValue = parseFloat(e.target.value);
    if (onChange) {
      // Clean up floating point precision issues
      const cleanValue = step < 1 ? parseFloat(newValue.toFixed(2)) : Math.round(newValue);
      onChange(cleanValue);
    }
  };

  // Get Figma component name for debugging/logging
  const getFigmaComponentName = () => {
    const orientationName = FIGMA_COMPONENT_PROPERTIES.orientation[resolvedProps.orientation.toLowerCase()] || resolvedProps.orientation;
    const sizeName = FIGMA_COMPONENT_PROPERTIES.size[resolvedProps.size.toLowerCase()] || resolvedProps.size;
    const stateName = FIGMA_COMPONENT_PROPERTIES.state[resolvedProps.state.toLowerCase()] || resolvedProps.state;
    const valueName = FIGMA_COMPONENT_PROPERTIES.value[Math.round(resolvedProps.value)] || Math.round(resolvedProps.value);

    return `Orientation=${orientationName}, Size=${sizeName}, State=${stateName}, Value=${valueName}`;
  };

  // Handle drag start
  const handleDragStart = useCallback((e) => {
    setIsDragging(true);
    setIsAnimatingSnap(false);

    // Set initial drag value to current position
    const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
    const initialValue = pixelToValue(clientX);
    setDragValue(initialValue);

    // Initialize lastStepValue to current resolved value
    setLastStepValue(resolvedProps.value);

    if (onDragStart) {
      onDragStart();
    }
  }, [pixelToValue, onDragStart, resolvedProps.value]);

  // Handle drag end with smooth snapping
  const handleDragEnd = useCallback(() => {
    // Stop dragging immediately to prevent further mouse movements from affecting the slider
    setIsDragging(false);
    setLastStepValue(null); // Reset step tracking

    if (dragValue !== null) {
      const snappedValue = snapToStep(dragValue);

      // Animate to snapped position
      setIsAnimatingSnap(true);

      // Ensure final value is set (in case we didn't trigger it during drag)
      if (onChange && snappedValue !== lastStepValue) {
        onChange(snappedValue);
      }

      // Clear remaining drag state after animation completes
      setTimeout(() => {
        setDragValue(null);
        setIsAnimatingSnap(false);
      }, 200); // Match CSS transition duration
    }

    if (onDragEnd) {
      onDragEnd();
    }
  }, [dragValue, snapToStep, onChange, onDragEnd, lastStepValue]);

  // Add smooth drag event listeners
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const trackContainer = container.querySelector('.standard-slider-track-container');
    if (!trackContainer) return;

    // Do not attach interaction handlers when disabled
    if (isDisabled) {
      return;
    }

    // Mouse drag handlers
    const handleMouseDown = (e) => {
      e.preventDefault();
      handleDragStart(e);
    };

    const handleMouseMove = (e) => {
      if (isDragging) {
        e.preventDefault();
        handleSmoothDrag(e.clientX);
      }
    };

    const handleMouseUp = () => {
      if (isDragging) {
        handleDragEnd();
      }
    };

    // Touch drag handlers
    const handleTouchStart = (e) => {
      // With touch-action: none on the track, no need to preventDefault
      handleDragStart(e);
    };

    const handleTouchMove = (e) => {
      if (isDragging && e.touches.length > 0) {
        handleSmoothDrag(e.touches[0].clientX);
      }
    };

    const handleTouchEnd = () => {
      if (isDragging) {
        handleDragEnd();
      }
    };

    // Add event listeners
    trackContainer.addEventListener('mousedown', handleMouseDown);
    trackContainer.addEventListener('touchstart', handleTouchStart, { passive: true });

    // Global move and end events
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      trackContainer.removeEventListener('mousedown', handleMouseDown);
      trackContainer.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isDragging, handleDragStart, handleDragEnd, handleSmoothDrag, isDisabled]);

  // Build CSS classes using resolved props (support both lowercase and Figma capitalized)
  const containerClasses = [
    'standard-slider-container',
    `width-${resolvedProps.width}`, // Width variant class
    `orientation-${resolvedProps.orientation}`, // Keep original case from Figma
    `size-${resolvedProps.size}`, // Keep original case from Figma
    `state-${resolvedProps.state}`, // Keep original case from Figma
    resolvedProps.state.toLowerCase() === 'disabled' ? 'disabled' : '',
    resolvedProps.state.toLowerCase() === 'hover' ? 'hover' : '',
    resolvedProps.state.toLowerCase() === 'focus' ? 'focus' : '',
    isDragging ? 'dragging' : '',
    isAnimatingSnap ? 'snapping' : '',
    className
  ].filter(Boolean).join(' ');

  return (
    <div 
      ref={containerRef}
      className={containerClasses}
      {...props}
    >
      {/* Track container with active track, handle, and inactive track */}
      <div ref={trackRef} className="standard-slider-track-container" style={{ touchAction: 'none' }}>
        {/* Active track (left portion) - uses flex-grow based on value */}
        <div
          className="standard-slider-active-track"
          style={{
            flexGrow: activeTrackFlex,
            flexShrink: 0,
            flexBasis: 0
          }}
        >
          <div className="track"></div>
        </div>

        {/* Handle - positioned in flex layout between tracks */}
        <div className="standard-slider-handle">
          {/* Value badge that appears when dragging */}
          {showValueBadge && (
            <div className="standard-slider-value-badge">
              {valueBadgeFormatter
                ? valueBadgeFormatter(currentValue)
                : (step < 1 ? parseFloat(parseFloat(currentValue).toFixed(2)) : Math.round(currentValue))}
            </div>
          )}
        </div>

        {/* Inactive track (right portion) - uses flex-grow for remaining space */}
        <div
          className="standard-slider-inactive-track"
          style={{
            flexGrow: inactiveTrackFlex,
            flexShrink: 0,
            flexBasis: 0
          }}
        >
          <div className="track"></div>

          {/* Track stops if enabled */}
          {resolvedProps.showStops && (
            <div
              className="standard-slider-track-stop"
              style={{
                left: '161px' // Figma absolute position
              }}
            >
              <div className="dot"></div>
            </div>
          )}

          {/* End stop - Material Design 3 dot at end of track */}
          <div
            className={`standard-slider-end-stop ${shouldHideEndStop ? 'hidden' : ''}`}
          ></div>
        </div>

        {/* Hidden input for accessibility - not used for interaction */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={resolvedProps.value}
          onChange={handleChange}
          className="standard-slider-input"
          id={id}
          aria-label={ariaLabel || t('common.slider', 'Slider')}
          disabled={isDisabled}
          data-figma-component={getFigmaComponentName()}
          tabIndex={-1}
          style={{ pointerEvents: 'none' }}
        />
      </div>

      {/* Value indicator if enabled */}
      {resolvedProps.showValueIndicator && (
        <div className="standard-slider-value-indicator">
          {step < 1 ? parseFloat(parseFloat(currentValue).toFixed(2)) : Math.round(currentValue)}{max <= 1 ? '' : '%'}
        </div>
      )}

      {/* Icon if enabled */}
      {resolvedProps.showIcon && (
        <div className="standard-slider-icon">
          {/* Icon implementation would go here */}
        </div>
      )}
    </div>
  );
};

export default StandardSlider;
