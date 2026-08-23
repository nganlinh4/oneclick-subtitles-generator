/**
 * Browser storage is intentionally limited to the non-project detected-language preference.
 * Narration results are project/revision-owned native records and are published through
 * projectNarrationState; mirroring them to window made stale results survive project switches.
 * @returns {{loadDetectedLanguage: Function}}
 */
const useNarrationStorage = () => {
  // Load previously detected language from localStorage
  const loadDetectedLanguage = () => {
    try {
      const savedLanguageData = localStorage.getItem('detected_language');
      if (savedLanguageData) {
        return JSON.parse(savedLanguageData);
      }
    } catch (error) {
      // Silently fail if data can't be loaded
      console.error('Error loading detected language from localStorage:', error);
    }
    return null;
  };

  return {
    loadDetectedLanguage
  };
};

export default useNarrationStorage;
