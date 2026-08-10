import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { initializeFunctionalScrollbars } from '../../utils/functionalScrollbar';
import '../../styles/common/custom-scrollbar-textarea.css';

/**
 * CustomScrollbarTextarea - A reusable textarea component with beautiful custom scrollbar
 * 
 * Features:
 * - Hidden native scrollbar
 * - Beautiful pill-shaped custom scrollbar
 * - Real-time dragging
 * - Auto-hide when content fits
 * - Fully accessible
 * - Supports all standard textarea props
 */
const CustomScrollbarTextarea = forwardRef(({
  className = '',
  containerClassName = '',
  value = '',
  onChange,
  placeholder = '',
  rows = 3,
  disabled = false,
  readOnly = false,
  style = {},
  containerStyle = {},
  onFocus,
  onBlur,
  onScroll,
  ...textareaProps
}, ref) => {
  const containerRef = useRef(null);
  const textareaRef = useRef(null);

  // Expose textarea methods to parent components
  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    blur: () => textareaRef.current?.blur(),
    select: () => textareaRef.current?.select(),
    setSelectionRange: (start, end) => textareaRef.current?.setSelectionRange(start, end),
    scrollTo: (options) => textareaRef.current?.scrollTo(options),
    get value() { return textareaRef.current?.value || ''; },
    set value(val) { if (textareaRef.current) textareaRef.current.value = val; },
    get scrollTop() { return textareaRef.current?.scrollTop || 0; },
    set scrollTop(val) { if (textareaRef.current) textareaRef.current.scrollTop = val; },
    get scrollHeight() { return textareaRef.current?.scrollHeight || 0; },
    get clientHeight() { return textareaRef.current?.clientHeight || 0; },
    textarea: textareaRef.current
  }));

  // Initialize custom scrollbar when component mounts
  useEffect(() => {
    const timer = setTimeout(() => {
      if (containerRef.current) {
        initializeFunctionalScrollbars();
      }
    }, 100); // Small delay to ensure DOM is ready

    return () => {
      clearTimeout(timer);
      // Cleanup will be handled by the functional scrollbar utility
    };
  }, []);

  // Reinitialize when value changes significantly (content size changes)
  useEffect(() => {
    const timer = setTimeout(() => {
      if (containerRef.current) {
        initializeFunctionalScrollbars();
      }
    }, 50);

    return () => clearTimeout(timer);
  }, [value]);

  // Handle textarea events
  const handleChange = (e) => {
    if (onChange) {
      onChange(e);
    }
  };

  const handleFocus = (e) => {
    if (onFocus) {
      onFocus(e);
    }
  };

  const handleBlur = (e) => {
    if (onBlur) {
      onBlur(e);
    }
  };

  const handleScroll = (e) => {
    if (onScroll) {
      onScroll(e);
    }
  };

  return (
    <div 
      ref={containerRef}
      className={`custom-scrollbar-textarea-container ${containerClassName}`}
      style={containerStyle}
    >
      <textarea
        ref={textareaRef}
        className={`custom-scrollbar-textarea ${className}`}
        value={value}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onScroll={handleScroll}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        readOnly={readOnly}
        style={style}
        {...textareaProps}
      />
    </div>
  );
});

CustomScrollbarTextarea.displayName = 'CustomScrollbarTextarea';

export default CustomScrollbarTextarea;
