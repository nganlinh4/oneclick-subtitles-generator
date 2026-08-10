/**
 * Service for syncing localStorage with the active platform persistence layer.
 */

import { persistDesktopSettings } from '../platform/settingsService';

/**
 * Persist eligible WebView preferences through the typed native settings boundary. Credentials,
 * project state, and transient capability data are filtered by the native settings service.
 * @returns {Promise<Object>} - Persistence result
 */
export const syncLocalStorageToServer = async () => {
  try {
    return await persistDesktopSettings(localStorage);
  } catch (error) {
    console.error('Error persisting WebView settings:', error);
    throw error;
  }
};
