import { useEffect } from 'react';
import { checkNarrationStatusWithRetry } from '../../../services/narrationService';

/**
 * Check Chatterbox availability by tracking which command was used to start the server
 * @returns {Promise<{available: boolean, message?: string}>}
 */
const checkChatterboxAvailability = async () => {
  try {
    const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3031';

    const response = await fetch(`${API_BASE_URL}/api/startup-mode`, {
      mode: 'cors',
      credentials: 'include',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      return {
        available: false,
        message: "Vui lòng chạy ứng dụng bằng npm run dev:cuda để dùng chức năng Thuyết minh."
      };
    }

    const startupData = await response.json();

    // Chatterbox is available if the server was started with npm run dev:cuda
    if (startupData.isDevCuda) {
      return {
        available: true
      };
    } else {
      return {
        available: false,
        message: "SERVICE_UNAVAILABLE" // Will be translated by frontend
      };
    }

  } catch (error) {
    return {
      available: false,
      message: "SERVICE_UNAVAILABLE" // Will be translated by frontend
    };
  }
};

/**
 * Custom hook for checking narration service availability
 * @param {Object} params - Parameters
 * @param {string} params.narrationMethod - Current narration method
 * @param {Function} params.setIsAvailable - Function to set F5-TTS availability
 * @param {Function} params.setIsGeminiAvailable - Function to set Gemini availability
 * @param {Function} params.setIsChatterboxAvailable - Function to set Chatterbox availability
 * @param {Function} params.setError - Function to set error message
 * @param {Function} params.t - Translation function
 * @returns {void}
 */
const useAvailabilityCheck = ({
  narrationMethod,
  setIsAvailable,
  setIsGeminiAvailable,
  setIsChatterboxAvailable,
  setError,
  t
}) => {
  // Check if narration services are available
  useEffect(() => {
    const checkAvailability = async () => {
      try {
        // First, do immediate checks for services that can be determined quickly

        // Check F5-TTS availability in the background
  const f5Status = await checkNarrationStatusWithRetry();

        // Set F5-TTS availability based on the actual status
        setIsAvailable(f5Status.available);

        // Check Chatterbox availability - same logic as F5-TTS
        const chatterboxStatus = await checkChatterboxAvailability();
        setIsChatterboxAvailable(chatterboxStatus.available);

        // Gemini availability is not checked globally - errors will be shown when actually using Gemini features
        // This allows users to use the app for other purposes without needing a Gemini API key
        setIsGeminiAvailable(true);

        // Set error message based on current method
        if (!f5Status.available && narrationMethod === 'f5tts' && f5Status.message) {
          // Translate service unavailable message if needed
          const errorMessage = f5Status.message === 'SERVICE_UNAVAILABLE'
            ? t('narration.serviceUnavailableMessage', 'Please run the application with npm run dev:cuda (OSG Full) to use the Voice Cloning feature. If already running with npm run dev:cuda (OSG Full), please wait about 1 minute for it to be ready.')
            : f5Status.message;
          setError(errorMessage);
        }
        else if (!chatterboxStatus.available && narrationMethod === 'chatterbox' && chatterboxStatus.message) {
          // Translate service unavailable message if needed
          const errorMessage = chatterboxStatus.message === 'SERVICE_UNAVAILABLE'
            ? t('narration.serviceUnavailableMessage', 'Please run the application with npm run dev:cuda (OSG Full) to use the Voice Cloning feature. If already running with npm run dev:cuda (OSG Full), please wait about 1 minute for it to be ready.')
            : chatterboxStatus.message;
          setError(errorMessage);
        }
        else {
          // Clear any previous errors
          setError('');
        }
      } catch (error) {
        console.error('Error checking service availability:', error);

        // Set error based on current method
        if (narrationMethod === 'f5tts') {
          setIsAvailable(false);
          setError(t('narration.serviceUnavailableMessage', 'Please run the application with npm run dev:cuda (OSG Full) to use the Voice Cloning feature. If already running with npm run dev:cuda (OSG Full), please wait about 1 minute for it to be ready.'));
        }
        else if (narrationMethod === 'chatterbox') {
          // Set Chatterbox as unavailable when not running with dev:cuda
          setIsChatterboxAvailable(false);
          setError(t('narration.serviceUnavailableMessage', 'Please run the application with npm run dev:cuda (OSG Full) to use the Voice Cloning feature. If already running with npm run dev:cuda (OSG Full), please wait about 1 minute for it to be ready.'));
        }
        else {
          // For Gemini and other methods, don't set global errors - specific errors will be shown when using the features
          setError('');
        }
      }
    };

    // Check availability once when component mounts or narration method changes
    checkAvailability();
  }, [t, narrationMethod, setIsAvailable, setIsGeminiAvailable, setIsChatterboxAvailable, setError]);
};

export default useAvailabilityCheck;
