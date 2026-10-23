import { useEffect } from 'react';
import { initGeminiButtonEffects, resetAllGeminiButtonEffects, disableGeminiButtonEffects } from '../../utils/geminiEffects';
import initTabPillAnimation from '../../utils/tabPillAnimation';
import { getThemeWithFallback } from '../../utils/systemDetection';
import { useModalScrollLock } from './useModalScrollLock';
import { readPreference, subscribePreference } from '../../platform/preferences/store';

const applyGeminiEffectsPreference = () => {
  if (readPreference('enable_gemini_effects')) initGeminiButtonEffects();
  else disableGeminiButtonEffects();
};

/**
 * Hook for managing application side effects
 */
export const useAppEffects = (props) => {
  useModalScrollLock();

  const {
    setTheme,
    subtitlesData,
    status,
  } = props;

  // Initialize UI effects after component mounts
  useEffect(() => {
    // Small delay to ensure DOM is fully rendered
    const timer = setTimeout(() => {
      applyGeminiEffectsPreference();

      // Initialize tab pill sliding animation
      initTabPillAnimation();
    }, 500);

    return () => clearTimeout(timer);
  }, []);

  // Re-initialize Gemini button effects when subtitles data changes
  useEffect(() => {
    if (subtitlesData && subtitlesData.length > 0) {
      // Use a small delay to ensure the DOM is updated
      const timer = setTimeout(() => {
        if (readPreference('enable_gemini_effects')) initGeminiButtonEffects();
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [subtitlesData]);

  // Reset all Gemini button effects when status changes
  useEffect(() => {
    if (status && (status.type === 'success' || status.type === 'error')) {
      // Use a small delay to ensure the DOM is updated
      const timer = setTimeout(() => {
        resetAllGeminiButtonEffects();
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [status]);

  // Follow Gemini effects changes made by Settings, here or in another window.
  useEffect(() => subscribePreference('enable_gemini_effects', applyGeminiEffectsPreference), []);

  // Follow theme changes committed in this window or another one.
  useEffect(() => subscribePreference('theme', () => setTheme(getThemeWithFallback())), [setTheme]);

};
