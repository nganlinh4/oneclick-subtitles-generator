import { useState, useEffect, useRef } from 'react';
import { readPreference } from '../../platform/preferences/store';

/**
 * Custom hook encapsulating the autoflow countdown for the transcription rules
 * editor. When the modal opens and was triggered by autoflow, it shows a
 * countdown banner and auto-invokes `onSave` when the countdown completes.
 *
 * @param {boolean} isOpen - Whether the modal is currently open.
 * @param {Function} onSave - Callback invoked when the countdown completes.
 * @returns {{showCountdown: boolean, countdown: number|null, handleUserInteraction: Function}}
 */
const useCountdownTimer = (isOpen, onSave) => {
  const [countdown, setCountdown] = useState(null);
  const [showCountdown, setShowCountdown] = useState(false);
  const [userInteracted, setUserInteracted] = useState(false);
  const countdownIntervalRef = useRef(null);
  const countdownTimeoutRef = useRef(null);

  // Initialize countdown if triggered by autoflow
  useEffect(() => {
    if (isOpen) {
      // Check if this was triggered by autoflow with countdown
      const shouldShowCountdown = sessionStorage.getItem('show_rules_editor_countdown') === 'true';

      if (shouldShowCountdown && !userInteracted) {
        const timeoutSetting = readPreference('video_analysis_timeout');

        if (timeoutSetting !== 'none') {
          if (timeoutSetting === 'infinite') {
            // For infinite countdown, just show a static message, no countdown
            setShowCountdown(true);
            setCountdown(-1); // Use -1 to indicate infinite
          } else {
            const seconds = parseInt(timeoutSetting, 10);
            if (!isNaN(seconds) && seconds > 0) {
              setShowCountdown(true);
              setCountdown(seconds);

              // Set up the countdown interval
              countdownIntervalRef.current = setInterval(() => {
                setCountdown(prev => {
                  if (prev <= 1) {
                    clearInterval(countdownIntervalRef.current);
                    return 0;
                  }
                  return prev - 1;
                });
              }, 1000);

              // Set up the auto-save timeout
              countdownTimeoutRef.current = setTimeout(() => {
                if (!userInteracted) {
                  onSave();
                }
              }, seconds * 1000);
            }
          }
        }
      }
    }

    return () => {
      // Cleanup countdown when modal closes
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      if (countdownTimeoutRef.current) {
        clearTimeout(countdownTimeoutRef.current);
        countdownTimeoutRef.current = null;
      }
      // Clean up the flag
      if (!isOpen) {
        sessionStorage.removeItem('show_rules_editor_countdown');
      }
    };
  }, [isOpen, userInteracted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop countdown on user interaction
  const handleUserInteraction = () => {
    if (showCountdown && !userInteracted) {
      setUserInteracted(true);
      setShowCountdown(false);
      setCountdown(null);

      // Clear the intervals
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      if (countdownTimeoutRef.current) {
        clearTimeout(countdownTimeoutRef.current);
        countdownTimeoutRef.current = null;
      }

    }
  };

  return { showCountdown, countdown, handleUserInteraction };
};

export default useCountdownTimer;
