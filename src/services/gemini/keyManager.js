/**
 * Gemini key compatibility layer.
 *
 * The browser build keeps the legacy local key manager used by the web app. The
 * desktop renderer delegates to the native-only facade, so provider secrets are
 * never read back from the credential vault or exposed to the WebView.
 */
import { initializeCredentialState } from '../../platform/credentialStateController';
import { isDesktopRuntime } from '../../platform/runtimeEnvironment';

const GEMINI_KEYS_STORAGE = 'gemini_api_keys';
const ACTIVE_KEY_INDEX_STORAGE = 'gemini_active_key_index';
const LEGACY_KEY_STORAGE = 'gemini_api_key';
const BLACKLIST_STORAGE = 'gemini_blacklisted_keys';
const BLACKLIST_TIMEOUT = 5 * 60 * 1000;
const blacklistedKeys = new Map();
let browserBlacklistLoaded = false;

const browserMode = () => !isDesktopRuntime();

const persistBrowserBlacklist = () => {
  try {
    localStorage.setItem(BLACKLIST_STORAGE, JSON.stringify(Object.fromEntries(blacklistedKeys)));
  } catch {
    // A storage failure must not prevent a browser provider request.
  }
};

const loadBrowserBlacklist = () => {
  if (!browserMode() || browserBlacklistLoaded) return;
  browserBlacklistLoaded = true;
  try {
    const parsed = JSON.parse(localStorage.getItem(BLACKLIST_STORAGE) || '{}');
    const now = Date.now();
    Object.entries(parsed).forEach(([key, expiry]) => {
      if (typeof expiry === 'number' && expiry > now) blacklistedKeys.set(key, expiry);
    });
  } catch {
    // Corrupt legacy cooldown state is ignored.
  }
};

const browserGetAllKeys = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(GEMINI_KEYS_STORAGE) || '[]');
    if (Array.isArray(parsed)) {
      const keys = parsed.filter((key) => typeof key === 'string' && key.trim());
      if (keys.length > 0) return keys;
    }
  } catch {
    // Fall through to the legacy single key.
  }
  const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
  return legacy?.trim() ? [legacy] : [];
};

export const initKeyManager = () => {
  if (!browserMode()) {
    initializeCredentialState().catch(() => undefined);
    return undefined;
  }
  const legacy = localStorage.getItem(LEGACY_KEY_STORAGE);
  if (legacy?.trim() && !localStorage.getItem(GEMINI_KEYS_STORAGE)) {
    localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify([legacy]));
    localStorage.setItem(ACTIVE_KEY_INDEX_STORAGE, '0');
  }
  loadBrowserBlacklist();
  return undefined;
};

export const getAllKeys = () => (
  browserMode() ? browserGetAllKeys() : []
);

export const getActiveKeyIndex = () => {
  if (!browserMode()) return 0;
  const parsed = Number.parseInt(localStorage.getItem(ACTIVE_KEY_INDEX_STORAGE) || '0', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export const setActiveKeyIndex = (index) => {
  if (!browserMode()) return false;
  const keys = browserGetAllKeys();
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) return false;
  localStorage.setItem(ACTIVE_KEY_INDEX_STORAGE, String(index));
  localStorage.setItem(LEGACY_KEY_STORAGE, keys[index]);
  return true;
};

export const saveAllKeys = (keys) => {
  if (!browserMode()) return false;
  if (!Array.isArray(keys)) return false;
  const valid = keys.filter((key) => typeof key === 'string' && key.trim());
  localStorage.setItem(GEMINI_KEYS_STORAGE, JSON.stringify(valid));
  if (valid.length === 0) {
    localStorage.removeItem(LEGACY_KEY_STORAGE);
    localStorage.setItem(ACTIVE_KEY_INDEX_STORAGE, '0');
  } else {
    const activeIndex = Math.min(getActiveKeyIndex(), valid.length - 1);
    localStorage.setItem(ACTIVE_KEY_INDEX_STORAGE, String(activeIndex));
    localStorage.setItem(LEGACY_KEY_STORAGE, valid[activeIndex]);
  }
  return true;
};

export const addKey = (key) => {
  if (!browserMode()) return false;
  if (typeof key !== 'string' || !key.trim()) return false;
  const keys = browserGetAllKeys();
  if (keys.includes(key)) return false;
  return saveAllKeys([...keys, key]);
};

export const removeKey = (key) => {
  if (!browserMode()) return false;
  const keys = browserGetAllKeys();
  const index = keys.indexOf(key);
  if (index < 0) return false;
  keys.splice(index, 1);
  return saveAllKeys(keys);
};

export const getCurrentKey = () => {
  if (!browserMode()) return null;
  const keys = browserGetAllKeys();
  return keys[getActiveKeyIndex() < keys.length ? getActiveKeyIndex() : 0] ?? null;
};

export const isKeyBlacklisted = (key) => {
  if (!browserMode()) return false;
  loadBrowserBlacklist();
  const expiry = blacklistedKeys.get(key);
  if (typeof expiry !== 'number') return false;
  if (expiry > Date.now()) return true;
  blacklistedKeys.delete(key);
  persistBrowserBlacklist();
  return false;
};

export const rotateToNextKey = () => {
  if (!browserMode()) return null;
  const keys = browserGetAllKeys();
  if (keys.length === 0) return null;
  const start = getActiveKeyIndex() < keys.length ? getActiveKeyIndex() : 0;
  for (let offset = 1; offset <= keys.length; offset += 1) {
    const index = (start + offset) % keys.length;
    if (!isKeyBlacklisted(keys[index])) {
      setActiveKeyIndex(index);
      return keys[index];
    }
  }
  return null;
};

export const blacklistKey = (key) => {
  if (!browserMode()) return false;
  if (typeof key !== 'string' || !key) return false;
  loadBrowserBlacklist();
  blacklistedKeys.set(key, Date.now() + BLACKLIST_TIMEOUT);
  persistBrowserBlacklist();
  if (getCurrentKey() === key) rotateToNextKey();
  return true;
};

export const getNextAvailableKey = () => {
  if (!browserMode()) return null;
  const current = getCurrentKey();
  if (current && !isKeyBlacklisted(current)) return current;
  return rotateToNextKey();
};

initKeyManager();
