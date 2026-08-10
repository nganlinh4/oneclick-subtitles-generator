/**
 * Compatibility facade for callers that still expect the former synchronous key-manager API.
 * Provider secrets live exclusively in the native credential vault and are never returned here.
 */
export {
  addKey,
  blacklistKey,
  getActiveKeyIndex,
  getAllKeys,
  getCurrentKey,
  getNextAvailableKey,
  initKeyManager,
  isKeyBlacklisted,
  removeKey,
  rotateToNextKey,
  saveAllKeys,
  setActiveKeyIndex,
} from '../../platform/desktopGeminiKeyManager';
