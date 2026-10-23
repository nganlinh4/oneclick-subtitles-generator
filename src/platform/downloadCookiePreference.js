import { readPreference } from './preferences/store';

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

/** The selected browser, or Chrome for anything that is not a supported browser source. */
export const normalizeDownloadCookieBrowser = (value) => (
  typeof value === 'string' && browserSources.has(value)
    ? value
    : DEFAULT_DOWNLOAD_COOKIE_BROWSER
);

/** The cookie toggle and selected browser; the effective source is `none` while disabled. */
export const readDownloadCookiePreference = () => {
  const enabled = readPreference(DOWNLOAD_COOKIE_ENABLED_SETTING_KEY);
  const selectedSource = normalizeDownloadCookieBrowser(
    readPreference(DOWNLOAD_COOKIE_SOURCE_SETTING_KEY)
  );
  return Object.freeze({
    enabled,
    selectedSource,
    cookieSource: enabled ? selectedSource : 'none',
  });
};

export const getDownloadCookieSource = () => readDownloadCookiePreference().cookieSource;
