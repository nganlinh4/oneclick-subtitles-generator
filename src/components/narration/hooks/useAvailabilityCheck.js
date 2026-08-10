import { useEffect } from 'react';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
const unavailable = () => ({ available: false, message: 'SERVICE_UNAVAILABLE' });

export const checkNativeNarrationAvailability = async (
  adapter = nativeNarrationAdapter
) => {
  const status = await adapter.getStatus();
  const checkBackend = async (backend) => {
    const snapshot = status.backends.find((candidate) => candidate.backend === backend);
    if (!snapshot?.installed) return unavailable();
    try {
      const probe = await adapter.probe(backend);
      return probe.status.ready ? { available: true } : unavailable();
    } catch {
      return unavailable();
    }
  };

  const [f5Status, chatterboxStatus] = await Promise.all([
    checkBackend('f5Tts'),
    checkBackend('chatterbox'),
  ]);
  return { f5Status, chatterboxStatus };
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
        if (!isDesktopRuntime()) {
          setIsAvailable(false);
          setIsChatterboxAvailable(false);
          setIsGeminiAvailable(false);
          setError('');
          return;
        }
        const { f5Status, chatterboxStatus } = await checkNativeNarrationAvailability();

        // Set F5-TTS availability based on the actual status
        setIsAvailable(f5Status.available);

        // Check Chatterbox availability - same logic as F5-TTS
        setIsChatterboxAvailable(chatterboxStatus.available);

        // Gemini availability is not checked globally - errors will be shown when actually using Gemini features
        // This allows users to use the app for other purposes without needing a Gemini API key
        setIsGeminiAvailable(true);

        // Set error message based on current method
        if (!f5Status.available && narrationMethod === 'f5tts' && f5Status.message) {
          // Translate service unavailable message if needed
          const errorMessage = f5Status.message === 'SERVICE_UNAVAILABLE'
            ? t('narration.serviceUnavailableMessage', 'Install or start the voice cloning engine from Settings > Tools. If it just started, wait about 1 minute for it to become ready.')
            : f5Status.message;
          setError(errorMessage);
        }
        else if (!chatterboxStatus.available && narrationMethod === 'chatterbox' && chatterboxStatus.message) {
          // Translate service unavailable message if needed
          const errorMessage = chatterboxStatus.message === 'SERVICE_UNAVAILABLE'
            ? t('narration.serviceUnavailableMessage', 'Install or start the voice cloning engine from Settings > Tools. If it just started, wait about 1 minute for it to become ready.')
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
          setError(t('narration.serviceUnavailableMessage', 'Install or start the voice cloning engine from Settings > Tools. If it just started, wait about 1 minute for it to become ready.'));
        }
        else if (narrationMethod === 'chatterbox') {
          // Set Chatterbox as unavailable when the engine is not running.
          setIsChatterboxAvailable(false);
          setError(t('narration.serviceUnavailableMessage', 'Install or start the voice cloning engine from Settings > Tools. If it just started, wait about 1 minute for it to become ready.'));
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
