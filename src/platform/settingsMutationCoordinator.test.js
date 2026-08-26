import {
  APP_FONT_PREFERENCE,
  PREFERRED_LANGUAGE_PREFERENCE,
} from './nativeUiPreferences';
import { commitThemePreference } from './themePreference';
import {
  SettingsResetInProgressError,
  isSettingsResetActive,
  runExclusiveSettingsReset,
  runTerminalSettingsReset,
  subscribeSettingsResetState,
} from './settingsMutationCoordinator';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
};

it('drains app-font, theme, and language transactions before reset clears their mirrors', async () => {
  const appFontNative = deferred();
  const themeNative = deferred();
  const languageNative = deferred();
  const appFontStorage = createStorage();
  const themeStorage = createStorage();
  const languageStorage = createStorage();
  const appFontApply = vi.fn();
  const languageApply = vi.fn();
  const themeRoot = { setAttribute: vi.fn() };
  const themePublish = vi.fn();

  const appFontCommit = APP_FONT_PREFERENCE.commit('system-ui', {
    storage: appFontStorage,
    invokeCommand: vi.fn(() => appFontNative.promise),
    apply: appFontApply,
  });
  const themeCommit = commitThemePreference('light', {
    storage: themeStorage,
    root: themeRoot,
    publish: themePublish,
    invokeCommand: vi.fn(() => themeNative.promise),
  });
  const languageCommit = PREFERRED_LANGUAGE_PREFERENCE.commit('ko', {
    storage: languageStorage,
    invokeCommand: vi.fn(() => languageNative.promise),
    apply: languageApply,
  });

  const clear = vi.fn(() => {
    expect(appFontStorage.getItem('app_font')).toBe('system-ui');
    expect(themeStorage.getItem('theme')).toBe('light');
    expect(languageStorage.getItem('preferred_language')).toBe('ko');
    appFontStorage.clear();
    themeStorage.clear();
    languageStorage.clear();
  });
  const reset = runExclusiveSettingsReset(clear);

  expect(isSettingsResetActive()).toBe(true);
  expect(clear).not.toHaveBeenCalled();

  const blockedInvoke = vi.fn();
  await expect(APP_FONT_PREFERENCE.commit('noto-sans', {
    storage: appFontStorage,
    invokeCommand: blockedInvoke,
  })).rejects.toBeInstanceOf(SettingsResetInProgressError);
  expect(blockedInvoke).not.toHaveBeenCalled();

  appFontNative.resolve();
  themeNative.resolve();
  await Promise.all([appFontCommit, themeCommit]);
  expect(clear).not.toHaveBeenCalled();

  languageNative.resolve();
  await Promise.all([languageCommit, reset]);

  expect(clear).toHaveBeenCalledOnce();
  expect(appFontApply).toHaveBeenCalledExactlyOnceWith('system-ui');
  expect(languageApply).toHaveBeenCalledExactlyOnceWith('ko');
  expect(themeRoot.setAttribute).toHaveBeenCalledExactlyOnceWith('data-theme', 'light');
  expect(themePublish).toHaveBeenCalledExactlyOnceWith('light');
  expect(appFontStorage.getItem('app_font')).toBeNull();
  expect(themeStorage.getItem('theme')).toBeNull();
  expect(languageStorage.getItem('preferred_language')).toBeNull();
  expect(isSettingsResetActive()).toBe(false);
});

it('settles a rejected write, releases a rejected reset, and accepts the next commit', async () => {
  const nativeWrite = deferred();
  const storage = createStorage({ preferred_language: 'en' });
  const apply = vi.fn();
  const stateChanges = [];
  const unsubscribe = subscribeSettingsResetState(() => {
    stateChanges.push(isSettingsResetActive());
  });

  const write = PREFERRED_LANGUAGE_PREFERENCE.commit('vi', {
    storage,
    apply,
    invokeCommand: vi.fn(() => nativeWrite.promise),
  });
  const resetFailure = new Error('reset refused');
  const resetOperation = vi.fn().mockRejectedValue(resetFailure);
  const reset = runExclusiveSettingsReset(resetOperation);

  nativeWrite.reject(new Error('write refused'));
  await expect(write).rejects.toThrow('write refused');
  await expect(reset).rejects.toBe(resetFailure);

  expect(resetOperation).toHaveBeenCalledOnce();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(stateChanges).toEqual([true, false]);
  expect(isSettingsResetActive()).toBe(false);

  const invokeCommand = vi.fn().mockResolvedValue(undefined);
  await expect(PREFERRED_LANGUAGE_PREFERENCE.commit('ko', {
    storage,
    apply,
    invokeCommand,
  })).resolves.toBe('ko');
  expect(invokeCommand).toHaveBeenCalledOnce();
  expect(storage.getItem('preferred_language')).toBe('ko');

  unsubscribe();
});

it('keeps terminal reset ownership after completion so the old document cannot publish again', async () => {
  const resetOperation = vi.fn().mockResolvedValue('reload-requested');

  await expect(runTerminalSettingsReset(resetOperation)).resolves.toBe('reload-requested');
  expect(isSettingsResetActive()).toBe(true);

  const invokeCommand = vi.fn();
  await expect(APP_FONT_PREFERENCE.commit('system-ui', {
    storage: createStorage(),
    invokeCommand,
  })).rejects.toBeInstanceOf(SettingsResetInProgressError);
  expect(invokeCommand).not.toHaveBeenCalled();
});
