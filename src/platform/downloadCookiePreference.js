export const DOWNLOAD_COOKIE_SOURCES = Object.freeze([
  'none',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'brave',
  'safari',
  'vivaldi',
  'opera',
  'whale',
]);

export const DOWNLOAD_COOKIE_BROWSER_SOURCES = Object.freeze(
  DOWNLOAD_COOKIE_SOURCES.filter((source) => source !== 'none')
);

export const DOWNLOAD_COOKIE_ENABLED_SETTING_KEY = 'use_cookies_for_download';
export const DOWNLOAD_COOKIE_SOURCE_SETTING_KEY = 'download_cookie_source';

const browserSources = new Set(DOWNLOAD_COOKIE_BROWSER_SOURCES);
const DEFAULT_DOWNLOAD_COOKIE_BROWSER = 'chrome';

const defaultStorage = () => globalThis.localStorage;

const safelyRead = (storage, key) => {
  try {
    return storage?.getItem?.(key) ?? null;
  } catch {
    return null;
  }
};

export const normalizeDownloadCookieBrowser = (value) => (
  typeof value === 'string' && browserSources.has(value)
    ? value
    : DEFAULT_DOWNLOAD_COOKIE_BROWSER
);

export const readDownloadCookiePreference = (storage = defaultStorage()) => {
  const enabled = safelyRead(storage, DOWNLOAD_COOKIE_ENABLED_SETTING_KEY) === 'true';
  const selectedSource = normalizeDownloadCookieBrowser(
    safelyRead(storage, DOWNLOAD_COOKIE_SOURCE_SETTING_KEY)
  );
  return Object.freeze({
    enabled,
    selectedSource,
    cookieSource: enabled ? selectedSource : 'none',
  });
};

export const getDownloadCookieSource = (storage = defaultStorage()) => (
  readDownloadCookiePreference(storage).cookieSource
);

export const createDownloadCookiePreferenceValues = ({ enabled, selectedSource }) => Object.freeze({
  [DOWNLOAD_COOKIE_ENABLED_SETTING_KEY]: (enabled === true).toString(),
  [DOWNLOAD_COOKIE_SOURCE_SETTING_KEY]: normalizeDownloadCookieBrowser(selectedSource),
});

export const writeDownloadCookiePreference = ({ enabled, selectedSource }, storage = defaultStorage()) => {
  const values = createDownloadCookiePreferenceValues({ enabled, selectedSource });
  const normalizedEnabled = values[DOWNLOAD_COOKIE_ENABLED_SETTING_KEY] === 'true';
  const normalizedSource = values[DOWNLOAD_COOKIE_SOURCE_SETTING_KEY];
  Object.entries(values).forEach(([key, value]) => storage.setItem(key, value));
  return Object.freeze({
    enabled: normalizedEnabled,
    selectedSource: normalizedSource,
    cookieSource: normalizedEnabled ? normalizedSource : 'none',
  });
};
