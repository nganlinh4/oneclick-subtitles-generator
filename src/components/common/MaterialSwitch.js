import React, { useEffect, useRef } from 'react';
import '@material/web/switch/switch.js';

/**
 * Material Web Switch Component
 * A wrapper around the Material Web md-switch element for React integration
 *
 * @param {Object} props - Component props
 * @param {boolean} props.checked - Whether the switch is checked
 * @param {Function} props.onChange - Callback function when switch state changes
 * @param {boolean} props.disabled - Whether the switch is disabled
 * @param {string} props.id - ID for the switch element
 * @param {string} props.ariaLabel - Aria label for accessibility
 * @param {string} props.ariaLabelledBy - ID of element that labels this switch
 * @param {boolean} props.icons - Whether to show icons in the switch (default: true for check/close icons)
 * @param {boolean} props.showOnlySelectedIcon - Whether to show icon only when selected
 * @param {string} props.className - Additional CSS classes
 * @param {Object} props.style - Inline styles
 * @returns {JSX.Element} Material Web Switch component
 */
const MaterialSwitch = ({
  checked = false,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  ariaLabelledBy,
  icons = true, // Default to true to show check/close icons
  showOnlySelectedIcon = false,
  className = '',
  style = {},
  ...otherProps
}) => {
  const switchRef = useRef(null);

  // Inline var overrides: only neutralize background for unselected state; keep border intact
  const unselectedInlineVars = !checked
    ? {
        // Base + state-specific variables that some builds reference
        '--md-switch-track-color': 'transparent',
        '--md-switch-hover-track-color': 'transparent',
        '--md-switch-pressed-track-color': 'transparent',
        // Unselected-specific variables used by other builds
        '--md-switch-unselected-track-color': 'transparent',
        '--md-switch-unselected-hover-track-color': 'transparent',
        '--md-switch-unselected-pressed-track-color': 'transparent',
        '--md-switch-unselected-focus-track-color': 'transparent',
      }
    : {};

  const mergedStyle = { ...style, ...unselectedInlineVars };

  useEffect(() => {
    const switchElement = switchRef.current;
    if (!switchElement) return;

    // Set initial state
    switchElement.selected = checked;
    switchElement.disabled = disabled;

    // Handle change events
    const handleChange = (event) => {
      if (onChange) {
        onChange({
          target: {
            checked: event.target.selected,
            value: event.target.selected
          }
        });
      }
    };

    switchElement.addEventListener('change', handleChange);

    return () => {
      switchElement.removeEventListener('change', handleChange);
    };
  }, [checked, disabled, onChange]);

  // Update checked state when prop changes
  useEffect(() => {
    if (switchRef.current) {
      switchRef.current.selected = checked;
    }
  }, [checked]);

  // Update disabled state when prop changes
  useEffect(() => {
    if (switchRef.current) {
      switchRef.current.disabled = disabled;
    }
  }, [disabled]);

  // Compute class names to include 'unselected' when not checked
  const computedClassName = `${className} ${!checked ? 'unselected' : 'selected'}`.trim();

  return (
    <md-switch
      ref={switchRef}
      id={id}
      className={computedClassName}
      style={mergedStyle}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      icons={icons ? '' : undefined}
      show-only-selected-icon={showOnlySelectedIcon ? '' : undefined}
      {...otherProps}
    >
      {icons && (
        <>
          {/* Custom bold check icon for selected state */}
          <svg slot="on-icon" xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
            <path d="m382-388 321-321q19-19 45-19t45 19q19 19 19 45t-19 45L427-253q-19 19-45 19t-45-19L167-423q-19-19-19-45t19-45q19-19 45-19t45 19l125 125Z"/>
          </svg>
          {/* Custom bold close icon for unselected state */}
          <svg slot="off-icon" xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="currentColor">
            <path d="M480-392 300-212q-18 18-44 18t-44-18q-18-18-18-44t18-44l180-180-180-180q-18-18-18-44t18-44q18-18 44-18t44 18l180 180 180-180q18-18 44-18t44 18q18 18 18 44t-18 44L568-480l180 180q18 18 18 44t-18 44q-18 18-44 18t-44-18L480-392Z"/>
          </svg>
        </>
      )}
    </md-switch>
  );
};

export default MaterialSwitch;
