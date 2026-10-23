import { readPreference } from '../../../platform/preferences/store';
/**
 * Browser storage is intentionally limited to the non-project detected-language preference.
 * Narration results are project/revision-owned native records and are published through
 * projectNarrationState; mirroring them to window made stale results survive project switches.
 * @returns {{loadDetectedLanguage: Function}}
 */
const useNarrationStorage = () => {
  const loadDetectedLanguage = () => readPreference('detected_language');

  return {
    loadDetectedLanguage
  };
};

export default useNarrationStorage;
