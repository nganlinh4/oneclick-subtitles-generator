import React, { useEffect } from 'react';
import '../../styles/common/toast.css';

/**
 * Custom Toast notification component
 * @param {Object} props - Component props
 * @param {boolean} props.open - Whether the toast is visible
 * @param {string} props.message - Message to display
 * @param {string} props.severity - Severity level (success, error, info, warning)
 * @param {Function} props.onClose - Function to call when closing the toast
 * @param {number} props.autoHideDuration - Duration in ms before auto-hiding (default: 2000)
 * @returns {JSX.Element|null} - Rendered component or null if not open
 */
const Toast = ({ open, message, severity = 'info', onClose, autoHideDuration = 2000 }) => {
  useEffect(() => {
    if (open && autoHideDuration) {
      const timer = setTimeout(() => {
        onClose && onClose();
      }, autoHideDuration);

      return () => clearTimeout(timer);
    }
  }, [open, autoHideDuration, onClose]);

  if (!open) return null;

  // Select icon based on severity
  const getIcon = () => {
    switch (severity) {
      case 'success':
        return <span className="material-symbols-rounded">check_circle</span>;
      case 'error':
        return <span className="material-symbols-rounded">error</span>;
      case 'warning':
        return <span className="material-symbols-rounded">warning</span>;
      case 'info':
      default:
        return <span className="material-symbols-rounded">info</span>;
    }
  };

  return (
    <div className={`custom-toast ${severity}`}>
      <div className="toast-icon">
        {getIcon()}
      </div>
      <div className="toast-message">
        {message}
      </div>
    </div>
  );
};

export default Toast;
