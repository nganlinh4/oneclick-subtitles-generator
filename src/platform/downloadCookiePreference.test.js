import {
  DOWNLOAD_COOKIE_ENABLED_SETTING_KEY,
  DOWNLOAD_COOKIE_SOURCE_SETTING_KEY,
  getDownloadCookieSource,
  normalizeDownloadCookieBrowser,
  readDownloadCookiePreference,
} from './downloadCookiePreference';

beforeEach(() => localStorage.clear());

it('migrates the enabled legacy boolean to Chrome when no explicit browser exists', () => {
  localStorage.setItem(DOWNLOAD_COOKIE_ENABLED_SETTING_KEY, 'true');

  expect(readDownloadCookiePreference()).toEqual({
    enabled: true,
    selectedSource: 'chrome',
    cookieSource: 'chrome',
  });
});

it.each(['chromium', 'edge', 'firefox', 'brave', 'safari', 'vivaldi', 'opera', 'whale'])(
  'uses the validated %s browser preference end to end',
  (selectedSource) => {
    localStorage.setItem(DOWNLOAD_COOKIE_ENABLED_SETTING_KEY, 'true');
    localStorage.setItem(DOWNLOAD_COOKIE_SOURCE_SETTING_KEY, selectedSource);

    expect(getDownloadCookieSource()).toBe(selectedSource);
  }
);

it('forces the effective source to none while disabled without forgetting the selection', () => {
  localStorage.setItem(DOWNLOAD_COOKIE_ENABLED_SETTING_KEY, 'false');
  localStorage.setItem(DOWNLOAD_COOKIE_SOURCE_SETTING_KEY, 'firefox');

  expect(readDownloadCookiePreference()).toEqual({
    enabled: false,
    selectedSource: 'firefox',
    cookieSource: 'none',
  });
});

it.each([['not-a-browser'], ['none'], [' Chrome '], [''], [null]])(
  'fails malformed source %s to Chrome when enabled and none when disabled',
  (source) => {
    if (source !== null) localStorage.setItem(DOWNLOAD_COOKIE_SOURCE_SETTING_KEY, source);
    localStorage.setItem(DOWNLOAD_COOKIE_ENABLED_SETTING_KEY, 'true');
    expect(getDownloadCookieSource()).toBe('chrome');

    localStorage.setItem(DOWNLOAD_COOKIE_ENABLED_SETTING_KEY, 'invalid');
    expect(getDownloadCookieSource()).toBe('none');
  }
);

it('normalizes a saved browser to a supported source', () => {
  expect(normalizeDownloadCookieBrowser('invalid')).toBe('chrome');
  expect(normalizeDownloadCookieBrowser('firefox')).toBe('firefox');
});

it('fails closed if preference storage cannot be read', () => {
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  try {
    expect(readDownloadCookiePreference()).toEqual({
      enabled: false,
      selectedSource: 'chrome',
      cookieSource: 'none',
    });
  } finally {
    getItem.mockRestore();
  }
});
