import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import '../../styles/common/tooltip.css';

/**
 * Reusable hover/click Tooltip component
 * - Default placement: top (above)
 * - Works even when the trigger is disabled (hover wrapper)
 * - Smart text balancing with adaptive width to target line count
 * - On mobile/touch devices, shows on click instead of hover
 */
const Tooltip = ({
  content,
  children,
  className = '',
  maxWidth, // if provided, overrides adaptive width
  placement = 'top', // currently supports 'top'
  preferredLines = 2, // target number of lines (1–3 recommended)
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const wrapperRef = useRef(null);
  const tooltipRef = useRef(null);

  useEffect(() => {
    // Handle clicks outside to close tooltip
    const handleClickOutside = (event) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target) &&
        tooltipRef.current &&
        !tooltipRef.current.contains(event.target)
      ) {
        setIsVisible(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const updatePosition = () => {
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      const icon = wrapperRef.current.querySelector('.help-icon');
      let targetRect = rect;
      if (icon) {
        targetRect = icon.getBoundingClientRect();
      }
      setPosition({
        top: targetRect.top - 8, // 8px above the trigger
        left: targetRect.left + targetRect.width / 2, // center horizontally
      });
    }
  };

  const handleTriggerClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsVisible(!isVisible);
    if (!isVisible) {
      // Update position when showing
      setTimeout(updatePosition, 0);
    }
  };

  const handleMouseEnter = () => {
    setIsVisible(true);
    updatePosition();
  };

  const handleMouseLeave = () => {
    setIsVisible(false);
  };

  useEffect(() => {
    if (isVisible) {
      updatePosition();
      // Update position on scroll/resize
      const handleUpdate = () => updatePosition();
      window.addEventListener('scroll', handleUpdate);
      window.addEventListener('resize', handleUpdate);
      return () => {
        window.removeEventListener('scroll', handleUpdate);
        window.removeEventListener('resize', handleUpdate);
      };
    }
  }, [isVisible]);
  // Compute an adaptive minimum width to avoid too many short lines. Bias to 1–2 lines.
  const computeAdaptiveMinWidth = (text, linesHint) => {
    if (typeof text !== 'string') return 360; // wide fallback
    const t = text.trim();
    if (!t) return 200;
    const words = t.split(/\s+/).filter(Boolean);
    const wc = words.length || 1;

    // Decide target lines based on word count; prefer 1–2 lines.
    let target = 2;
    if (wc <= 10) target = 1;
    else if (wc <= 20) target = 2;
    else if (wc <= 36) target = 2;
    else target = 3;
    if (typeof linesHint === 'number') {
      target = Math.min(target, Math.max(1, Math.round(linesHint)));
    }

    const length = t.length;
    const charsPerLine = Math.max(20, Math.min(40, Math.round(length / target)));
    const charPx = 7.0; // approx px per char at 13px font
    let widthPx = Math.round(charsPerLine * charPx);
    widthPx = Math.max(150, Math.min(400, widthPx)); // Reduced min/max widths
    return widthPx;
  };

  const resolvedWidth = typeof maxWidth === 'number'
    ? maxWidth
    : computeAdaptiveMinWidth(typeof content === 'string' ? content.replace(/<[^>]*>/g, '') : content, preferredLines);

  // Check if content is a string with HTML tags
  const hasHtml = typeof content === 'string' && /<[^>]*>/.test(content);

  return (
    <div
      ref={wrapperRef}
      className={`oc-tooltip-wrapper ${className}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleTriggerClick}
    >
      {children}
      {ReactDOM.createPortal(
        <div
          ref={tooltipRef}
          className={`oc-tooltip oc-tooltip-${placement} ${isVisible ? 'oc-tooltip-visible' : ''}`}
          style={{
            position: 'fixed',
            top: position.top,
            left: position.left,
            transform: 'translate(-50%, -100%)',
            pointerEvents: 'none',
            zIndex: 1000000,
          }}
          onMouseEnter={() => setIsVisible(true)}
          onMouseLeave={() => setIsVisible(false)}
        >
          <div className="oc-tooltip-content" style={{ width: 'fit-content', maxWidth: resolvedWidth }}>
            {hasHtml ? (
              <span dangerouslySetInnerHTML={{ __html: content }} />
            ) : (
              content
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default Tooltip;
