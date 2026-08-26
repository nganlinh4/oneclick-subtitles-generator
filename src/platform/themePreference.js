import { invokeDesktop } from './desktopRuntime';
import { runNativeFirstSettingsMutation } from './settingsMutationCoordinator';
import { getThemeWithFallback, setupSystemThemeListener } from '../utils/systemDetection';

const THEME_KEY = 'theme';
const themes = new Set(['dark', 'light']);

const requireTheme = (theme) => {
  if (!themes.has(theme)) throw new TypeError('A supported theme is required');
  return theme;
};

const defaultRoot = () => document.documentElement;
const defaultStorage = () => localStorage;

export const applyEffectiveTheme = (theme, { root = defaultRoot() } = {}) => {
  const effectiveTheme = requireTheme(theme);
  root.setAttribute('data-theme', effectiveTheme);
  return effectiveTheme;
};

/** Resolve and paint the effective theme without creating a user preference. */
export const initializeEffectiveTheme = ({
  resolveTheme = getThemeWithFallback,
  root = defaultRoot(),
} = {}) => applyEffectiveTheme(resolveTheme(), { root });

/** Follow OS changes only while no explicit light/dark preference exists. */
export const applySystemThemeIfUnpinned = (theme, {
  storage = defaultStorage(),
  root = defaultRoot(),
} = {}) => {
  const stored = storage.getItem(THEME_KEY);
  if (themes.has(stored)) return null;
  return applyEffectiveTheme(theme, { root });
};

export const subscribeToEffectiveSystemTheme = (onTheme = () => undefined, {
  listen = setupSystemThemeListener,
  storage = defaultStorage(),
  root = defaultRoot(),
} = {}) => listen((theme) => {
  const applied = applySystemThemeIfUnpinned(theme, { storage, root });
  if (applied !== null) onTheme(applied);
});

const publishThemeMirror = (theme) => {
  window.dispatchEvent(new StorageEvent('storage', {
    key: THEME_KEY,
    newValue: theme,
  }));
};

/** Commit explicit user intent to native authority before changing any WebView mirror. */
export const commitThemePreference = async (theme, {
  invokeCommand = invokeDesktop,
  storage,
  root,
  publish = publishThemeMirror,
  onProjectionWarning = () => undefined,
} = {}) => {
  const preference = requireTheme(theme);
  return runNativeFirstSettingsMutation({
    committedValue: preference,
    commitNative: () => invokeCommand('setting_set', {
      key: THEME_KEY,
      value: preference,
    }),
    projections: [
      {
        name: 'browserMirror',
        project: () => (
          storage === undefined ? defaultStorage() : storage
        ).setItem(THEME_KEY, preference),
      },
      {
        name: 'effectiveUi',
        project: () => applyEffectiveTheme(preference, {
          root: root === undefined ? defaultRoot() : root,
        }),
      },
      { name: 'publication', project: () => publish(preference) },
    ],
    onProjectionWarning,
  });
};

export const oppositeTheme = (theme) => (
  theme === 'light' || theme === 'system' ? 'dark' : 'light'
);
