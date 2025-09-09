import React from 'react';
import '../../styles/common/tooltip.css';

/**
 * Reusable hover Tooltip component
 * - Default placement: top (above)
 * - Works even when the trigger is disabled (hover wrapper)
 * - Smart text balancing with adaptive width to target line count
 */
const Tooltip = ({
  content,
  children,
  className = '',
  maxWidth, // if provided, overrides adaptive width
  placement = 'top', // currently supports 'top'
  preferredLines = 2, // target number of lines (1–3 recommended)
}) => {
  // Compute an adaptive minimum width to avoid too many short lines. Bias to 1–2 lines.
  const computeAdaptiveMinWidth = (text, linesHint) => {
    if (typeof text !== 'string') return 360; // wide fallback
    const t = text.trim();
    if (!t) return 300;
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
    const charsPerLine = Math.max(24, Math.min(48, Math.round(length / target)));
    const charPx = 7.0; // approx px per char at 13px font
    let widthPx = Math.round(charsPerLine * charPx);
    widthPx = Math.max(300, Math.min(560, widthPx));
    return widthPx;
  };

  const resolvedWidth = typeof maxWidth === 'number'
    ? maxWidth
    : computeAdaptiveMinWidth(content, preferredLines);

  return (
    <div className={`oc-tooltip-wrapper ${className}`}>
      <div className="oc-tooltip-trigger">
        {children}
      </div>
      <div className={`oc-tooltip oc-tooltip-${placement}`}>
        <div className="oc-tooltip-content balanced-text" style={{ width: 'max-content', maxWidth: resolvedWidth }}>
          {content}
        </div>
      </div>
    </div>
  );
};

export default Tooltip;
