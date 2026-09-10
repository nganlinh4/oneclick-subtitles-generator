import { invokeDesktop } from './desktopRuntime';
import { runNativeFirstSettingsMutation } from './settingsMutationCoordinator';

const preferenceKeyPattern = /^[a-z][a-z0-9_]{0,127}$/;
const defaultStorage = () => globalThis.localStorage;

/**
 * Define one bounded string preference whose durable authority is native SQLite.
 *
 * Reading the WebView mirror is side-effect free: a fallback is an effective value, not an
 * implicit user choice. Committing is deliberately native-first so a rejected native write cannot
 * leave the current WebView claiming a preference that will disappear on the next launch. After
 * durable success, each browser/UI projection is best-effort and independent: one broken mirror
 * cannot suppress the remaining current-window reconciliation.
 */
export const createEnumeratedUiPreference = ({ key, values }) => {
  if (typeof key !== 'string' || !preferenceKeyPattern.test(key)) {
    throw new TypeError('A bounded native preference key is required');
  }
  if (!Array.isArray(values) || values.length === 0
      || values.some((value) => typeof value !== 'string' || value.length === 0)
      || new Set(values).size !== values.length) {
    throw new TypeError('A non-empty unique preference value list is required');
  }

  const allowedValues = new Set(values);
  const requireValue = (value) => {
    if (!allowedValues.has(value)) throw new TypeError(`Unsupported ${key} preference`);
    return value;
  };

  return Object.freeze({
    key,
    values: Object.freeze([...values]),
    accepts: (value) => allowedValues.has(value),
    readMirror(fallback, { storage = defaultStorage() } = {}) {
      const effectiveFallback = requireValue(fallback);
      try {
        const stored = storage.getItem(key);
        return allowedValues.has(stored) ? stored : effectiveFallback;
      } catch {
        return effectiveFallback;
      }
    },
    async commit(value, {
      invokeCommand = invokeDesktop,
      storage,
      apply = () => undefined,
      publish = () => undefined,
      onProjectionWarning = () => undefined,
    } = {}) {
      const preference = requireValue(value);
      return runNativeFirstSettingsMutation({
        committedValue: preference,
        commitNative: () => invokeCommand('setting_set', { key, value: preference }),
        projections: [
          {
            name: 'browserMirror',
            project: () => (
              storage === undefined ? defaultStorage() : storage
            ).setItem(key, preference),
          },
          { name: 'effectiveUi', project: () => apply(preference) },
          { name: 'publication', project: () => publish(preference) },
        ],
        onProjectionWarning,
      });
    },
  });
};

export const APP_FONT_PREFERENCE = createEnumeratedUiPreference({
  key: 'app_font',
  values: ['google-sans', 'system-ui', 'noto-sans'],
});

export const APP_UI_SCALE_PREFERENCE = createEnumeratedUiPreference({
  key: 'app_ui_scale',
  values: ['80', '90', '100', '110', '120'],
});

const APP_FONT_STACKS = Object.freeze({
  'google-sans': Object.freeze({
    primary: '"Google Sans", "Open Sans", sans-serif',
    title: '"Google Sans", "Be Vietnam Pro", sans-serif',
  }),
  'system-ui': Object.freeze({
    primary: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
    title: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
  }),
  'noto-sans': Object.freeze({
    primary: '"Noto Sans", "Open Sans", sans-serif',
    title: '"Noto Sans", "Open Sans", sans-serif',
  }),
});

const defaultRoot = () => document.documentElement;

/** Paint one already-validated application font independently of any mounted settings UI. */
export const applyEffectiveAppFont = (font, { root = defaultRoot() } = {}) => {
  if (!APP_FONT_PREFERENCE.accepts(font)) {
    throw new TypeError('Unsupported app_font preference');
  }
  const stack = APP_FONT_STACKS[font];
  root.style.setProperty('--font-primary', stack.primary);
  root.style.setProperty('--font-title', stack.title);
  return font;
};

/**
 * Paint the native-hydrated WebView mirror on every launch. Reading a missing mirror uses the
 * visual default without persisting it, so startup cannot manufacture user intent.
 */
export const initializeEffectiveAppFont = ({
  storage = defaultStorage(),
  root = defaultRoot(),
} = {}) => applyEffectiveAppFont(
  APP_FONT_PREFERENCE.readMirror('google-sans', { storage }),
  { root },
);

export const applyEffectiveAppUiScale = (scale, { root = defaultRoot() } = {}) => {
  if (!APP_UI_SCALE_PREFERENCE.accepts(scale)) {
    throw new TypeError('Unsupported app_ui_scale preference');
  }
  root.style.zoom = `${scale}%`;
  return scale;
};

export const initializeEffectiveAppUiScale = ({
  storage = defaultStorage(),
  root = defaultRoot(),
} = {}) => applyEffectiveAppUiScale(
  APP_UI_SCALE_PREFERENCE.readMirror('100', { storage }),
  { root },
);

export const PREFERRED_LANGUAGE_PREFERENCE = createEnumeratedUiPreference({
  key: 'preferred_language',
  values: ['en', 'ko', 'vi'],
});
