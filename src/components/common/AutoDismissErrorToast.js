import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '../../styles/common/auto-dismiss-error-toast.css';

/**
 * Auto-dismissing error toast component that listens for error events
 * and displays localized error messages that disappear after 5 seconds
 */
const AutoDismissErrorToast = () => {
  const { t } = useTranslation();
  const [error, setError] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleAlignedNarrationError = (event) => {
      if (event.detail && event.detail.status === 'error') {
        const { message } = event.detail;

        if (message) {
          let localizedMessage = message;

          // Check if this is the specific "no narration results" error and localize it
          if (message.includes('No narration results available for alignment') ||
              message.includes('No narration results to generate aligned audio')) {
            localizedMessage = t('errors.noNarrationResults', 'No narration results to generate aligned audio');
          }

          setError(localizedMessage);
          setVisible(true);

          // Auto-hide after 5 seconds
          setTimeout(() => {
            setVisible(false);
            // Clear error after fade out animation
            setTimeout(() => {
              setError(null);
            }, 300);
          }, 5000);
        }
      }
    };

    // Listen for aligned narration status events
    window.addEventListener('aligned-narration-status', handleAlignedNarrationError);

    return () => {
      window.removeEventListener('aligned-narration-status', handleAlignedNarrationError);
    };
  }, [t]);

  if (!error || !visible) return null;

  return (
    <div className={`auto-dismiss-error-toast ${visible ? 'visible' : ''}`}>
      <div className="toast-icon">
        <span className="material-symbols-rounded">error</span>
      </div>
      <div className="toast-message">
        {error}
      </div>
    </div>
  );
};

export default AutoDismissErrorToast;
