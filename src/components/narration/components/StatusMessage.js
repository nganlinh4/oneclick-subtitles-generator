import React, { useEffect, useState } from 'react';

/**
 * Status Message component with smooth enter/exit height animation
 * Expands from 0 height on enter and collapses to 0 on exit to avoid abrupt layout shifts.
 * Works with the narration-section flow (no special container height animation required).
 *
 * @param {Object} props - Component props
 * @param {string} props.message - Message to display
 * @param {string} props.type - Message type (info, warning, error, success)
 * @param {React.RefObject} props.statusRef - Reference to status element
 * @param {boolean} props.showProgress - Whether to show a progress indicator
 * @param {boolean} props.isGenerating - Whether generation is in progress
 * @returns {JSX.Element|null} - Rendered component
 */
const StatusMessage = ({
  message,
  type = 'info',
  statusRef = null,
  showProgress = false,
  isGenerating = false
}) => {
  // Determine if the status should be shown based on props
  const shouldShow = ((!!message) || isGenerating) && !(type === 'error' && !message);

  // Keep the element mounted briefly to allow exit animation
  const [render, setRender] = useState(shouldShow);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (shouldShow) {
      // Ensure it's mounted and then expand on next frame
      setRender(true);
      const id = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(id);
    } else {
      // Start collapse, then unmount after transition duration
      setShow(false);
      const timeout = setTimeout(() => setRender(false), 320); // keep slightly longer than CSS for safety
      return () => clearTimeout(timeout);
    }
  }, [shouldShow]);

  if (!render) return null;

  return (
    <div
      className={`status-message status-banner ${type} ${showProgress ? 'with-progress' : ''} ${isGenerating ? 'generating' : ''} ${show ? 'status-show' : 'status-collapsed'}`}
      ref={statusRef}
    >
      {showProgress && (
        <div className="status-progress-indicator">
          <div className="status-progress-bar"></div>
        </div>
      )}
      <div className="status-message-text">
        {message || ''}
      </div>
    </div>
  );
};

export default StatusMessage;
