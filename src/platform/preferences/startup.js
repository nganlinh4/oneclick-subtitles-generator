// One-time preparation of stored preferences when the WebView starts.
import { migrateStoredGeminiModels } from '../../config/geminiModels';
import { purgeRetiredStorage, writePreference } from './store';
import { findPreference } from './registry';

/**
 * Remove retired keys and migrate retired Gemini model ids. A migrated native setting is also
 * committed to SQLite so the next launch does not restore the retired id into the mirror.
 */
export const prepareStoredPreferences = () => {
  purgeRetiredStorage();
  let changed = {};
  try {
    changed = migrateStoredGeminiModels(globalThis.localStorage);
  } catch {
    return;
  }
  Object.entries(changed).forEach(([key, value]) => {
    if (findPreference(key)?.persistence !== 'native') return;
    try {
      writePreference(key, value);
    } catch {
      // A value the codec refuses stays migrated in the mirror only.
    }
  });
};
