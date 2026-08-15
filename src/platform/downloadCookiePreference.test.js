import {
  DOWNLOAD_COOKIE_ENABLED_SETTING_KEY,
  DOWNLOAD_COOKIE_SOURCE_SETTING_KEY,
  getDownloadCookieSource,
  readDownloadCookiePreference,
  writeDownloadCookiePreference,
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

it('persists only a strict enabled flag and a validated browser', () => {
  expect(writeDownloadCookiePreference({ enabled: 1, selectedSource: 'invalid' })).toEqual({
    enabled: false,
    selectedSource: 'chrome',
    cookieSource: 'none',
  });
  expect(localStorage.getItem(DOWNLOAD_COOKIE_ENABLED_SETTING_KEY)).toBe('false');
  expect(localStorage.getItem(DOWNLOAD_COOKIE_SOURCE_SETTING_KEY)).toBe('chrome');
});

it('fails closed if preference storage cannot be read', () => {
  const storage = { getItem: () => { throw new Error('denied'); } };
  expect(readDownloadCookiePreference(storage)).toEqual({
    enabled: false,
    selectedSource: 'chrome',
    cookieSource: 'none',
  });
});
