import { useState, useEffect } from 'react';
import { detectSubtitleLanguage } from '../../../services/gemini/languageDetectionService';

/**
 * Custom hook that observes language-detection results for subtitle sources.
 *
 * Detection status is reported by the language service. Translation availability comes directly
 * from the project-owned React projection, so it cannot race a custom completion event.
 *
 * @param {Object} params
 * @param {string} params.subtitleSource - Current subtitle source ('original'|'translated')
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Function} params.setOriginalLanguage - Setter for original language
 * @param {Function} params.setTranslatedLanguage - Setter for translated language
 * @param {Function} params.onLanguageDetected - Callback when language is detected
 * @param {Object} params.lastOriginalLanguageRef - Ref holding last detected original language
 * @param {Object} params.lastTranslatedLanguageRef - Ref holding last detected translated language
 * @returns {{ isDetectingOriginal: boolean, isDetectingTranslated: boolean }}
 */
const useSubtitleLanguageDetection = ({
  subtitleSource,
  translatedSubtitles,
  setOriginalLanguage,
  setTranslatedLanguage,
  onLanguageDetected,
  lastOriginalLanguageRef,
  lastTranslatedLanguageRef
}) => {
  const [isDetectingOriginal, setIsDetectingOriginal] = useState(false);
  const [isDetectingTranslated, setIsDetectingTranslated] = useState(false);

  // Listen for language detection events
  useEffect(() => {
    const handleDetectionStatus = (event) => {
      const { source } = event.detail;
      if (source === 'original') {
        setIsDetectingOriginal(true);
      } else if (source === 'translated') {
        setIsDetectingTranslated(true);
      }
    };

    const handleDetectionComplete = (event) => {
      const { result, source } = event.detail;

      if (source === 'original') {
        setIsDetectingOriginal(false);
        setOriginalLanguage(result);
        // keep stable ref so UI doesn't flash when user switches pills
        lastOriginalLanguageRef.current = result;

        // Always call the callback when language is detected, regardless of current selection
        // This ensures modals update their recommended sections
        if (onLanguageDetected) {
          onLanguageDetected(source, result);
        }
      } else if (source === 'translated') {
        setIsDetectingTranslated(false);
        setTranslatedLanguage(result);
        // keep stable ref so UI doesn't flash when user switches pills
        lastTranslatedLanguageRef.current = result;

        // Always call the callback when language is detected, regardless of current selection
        // This ensures modals update their recommended sections
        if (onLanguageDetected) {
          onLanguageDetected(source, result);
        }
      }
    };

    const handleDetectionError = (event) => {
      const { source } = event.detail;
      if (source === 'original') {
        setIsDetectingOriginal(false);
      } else if (source === 'translated') {
        setIsDetectingTranslated(false);
      }
    };

    // Add event listeners
    window.addEventListener('language-detection-status', handleDetectionStatus);
    window.addEventListener('language-detection-complete', handleDetectionComplete);
    window.addEventListener('language-detection-error', handleDetectionError);

    // Clean up event listeners
    return () => {
      window.removeEventListener('language-detection-status', handleDetectionStatus);
      window.removeEventListener('language-detection-complete', handleDetectionComplete);
      window.removeEventListener('language-detection-error', handleDetectionError);
    };
  }, [onLanguageDetected, setOriginalLanguage, setTranslatedLanguage, lastOriginalLanguageRef, lastTranslatedLanguageRef]);

  useEffect(() => {
    if (!Array.isArray(translatedSubtitles) || translatedSubtitles.length === 0) {
      setIsDetectingTranslated(false);
      setTranslatedLanguage(null);
      return;
    }
    if (subtitleSource !== 'translated') return;
    setTranslatedLanguage(null);
    void detectSubtitleLanguage(translatedSubtitles, 'translated');
  }, [subtitleSource, translatedSubtitles, setTranslatedLanguage]);

  return { isDetectingOriginal, isDetectingTranslated };
};

export default useSubtitleLanguageDetection;
