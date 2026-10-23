import { useCallback, useSyncExternalStore } from 'react';

import { invokeDesktop } from '../desktopRuntime';
import { runNativeFirstSettingsMutation } from '../settingsMutationCoordinator';
import { persistDesktopSettings } from '../settingsService';
import { findPreference, RETIRED_STORAGE_KEYS } from './registry';

/**
 * The one typed preference store. Every key is declared in ./registry with its codec and its
 * persistence target:
 *
 *   - `native`: SQLite owns the value. WebView storage is the synchronous mirror the host
 *     re-seeds on every launch; a single write updates it optimistically and is rolled back if
 *     the native commit fails, a Settings save commits natively first.
 *   - `device`: a per-device UI convenience kept only in WebView storage.
 *
 * Changes reach subscribers in this window directly and other windows through `storage` events.
 */
const listeners = new Map();
const snapshots = new Map();
const nativeCommits = new Map();

const storage = () => globalThis.localStorage;

const definitionFor = (key) => {
  const definition = findPreference(key);
  if (!definition) throw new TypeError(`Undeclared preference: ${key}`);
  return definition;
};

const readRaw = (key) => {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const notify = (key) => {
  listeners.get(key)?.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('Preference listener failed:', error);
    }
  });
};

/** The effective value: the stored value when valid, otherwise the declared default. */
export const readPreference = (key) => {
  const definition = definitionFor(key);
  const raw = readRaw(key);
  const cached = snapshots.get(key);
  // Decoded objects are cached per stored string so React snapshots stay referentially stable.
  if (cached && cached.raw === raw) return cached.value;
  const value = definition.decode(raw);
  snapshots.set(key, { raw, value });
  return value;
};

/** Whether the user (or an older build) has stored any value for `key`. */
export const hasStoredPreference = (key) => {
  definitionFor(key);
  return readRaw(key) !== null;
};

/** The stored value when one exists in its canonical form, otherwise null (no default applied). */
export const readStoredPreference = (key) => {
  const definition = definitionFor(key);
  const raw = readRaw(key);
  if (raw === null) return null;
  const value = readPreference(key);
  return definition.encode(value) === raw ? value : null;
};

const writeMirror = (key, encoded) => {
  try {
    if (encoded === null) storage()?.removeItem(key);
    else storage()?.setItem(key, encoded);
  } catch {
    // Storage can be unavailable; subscribers still see the in-memory notification.
  }
  notify(key);
};

// Commit the latest optimistic value of `key`, coalescing writes made while one is in flight
// (a dragged slider). A refused commit restores the last value SQLite accepted.
const drainNativeCommits = async (key, entry) => {
  for (;;) {
    const value = entry.latest;
    try {
      await runNativeFirstSettingsMutation({
        committedValue: value,
        commitNative: () => invokeDesktop('setting_set', { key, value }),
      });
      entry.committed = value;
    } catch {
      if (entry.latest === value) {
        nativeCommits.delete(key);
        writeMirror(key, entry.committed);
        console.warn(`The ${key} preference could not be saved.`);
        return false;
      }
    }
    if (entry.latest === value) {
      nativeCommits.delete(key);
      return true;
    }
  }
};

/**
 * Store `value` for `key` and update every subscriber at once. A native preference then commits
 * to SQLite; the returned promise resolves to whether that commit (if any) succeeded.
 */
export const writePreference = (key, value) => {
  const definition = definitionFor(key);
  const encoded = definition.encode(definition.normalize(value));
  const previous = readRaw(key);
  writeMirror(key, encoded);
  if (definition.persistence !== 'native') return Promise.resolve(true);
  let entry = nativeCommits.get(key);
  if (entry) {
    entry.latest = encoded;
    return entry.running;
  }
  entry = { latest: encoded, committed: previous, running: null };
  nativeCommits.set(key, entry);
  entry.running = drainNativeCommits(key, entry);
  return entry.running;
};

/** Forget a device preference so its default applies again. */
export const clearPreference = (key) => {
  const definition = definitionFor(key);
  if (definition.persistence === 'native') {
    throw new TypeError('Native preferences are cleared only by a settings reset');
  }
  writeMirror(key, null);
};

/**
 * Commit several native preferences as one SQLite batch (the Settings modal's Save), then update
 * the mirror and notify each key. Values are validated before anything is written.
 */
export const commitNativePreferences = async (values) => {
  const encoded = {};
  for (const [key, value] of Object.entries(values)) {
    const definition = definitionFor(key);
    if (definition.persistence !== 'native') {
      throw new TypeError(`Preference ${key} is not native`);
    }
    encoded[key] = definition.encode(definition.normalize(value));
  }
  const publish = () => Object.entries(encoded).forEach(([key, value]) => writeMirror(key, value));
  return runNativeFirstSettingsMutation({
    committedValue: encoded,
    commitNative: () => persistDesktopSettings(encoded),
    projections: [{ name: 'browserMirror', project: publish }],
  });
};

export const subscribePreference = (key, listener) => {
  definitionFor(key);
  if (typeof listener !== 'function') throw new TypeError('A preference listener is required');
  let keyListeners = listeners.get(key);
  if (!keyListeners) {
    keyListeners = new Set();
    listeners.set(key, keyListeners);
  }
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
};

/** Tell subscribers of `key` that a native-first commit elsewhere updated its mirror. */
export const notifyPreference = (key) => {
  definitionFor(key);
  notify(key);
};

/** Re-read every subscribed key, e.g. after a reset cleared WebView storage wholesale. */
export const refreshAllPreferences = () => {
  [...listeners.keys()].forEach(notify);
};

/**
 * `[value, setValue]` for one declared preference; `setValue` also accepts an updater and, like a
 * React state setter, returns nothing. A control that produces an unrepresentable value (an
 * emptied number field) keeps the stored value.
 */
export const usePreference = (key) => {
  const subscribe = useCallback((listener) => subscribePreference(key, listener), [key]);
  const value = useSyncExternalStore(subscribe, () => readPreference(key));
  const setValue = useCallback((next) => {
    try {
      writePreference(key, typeof next === 'function' ? next(readPreference(key)) : next);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      console.warn(`Ignored an invalid ${key} preference value.`);
    }
  }, [key]);
  return [value, setValue];
};

/** Remove keys earlier builds wrote and nothing reads any more. Runs once at startup. */
export const purgeRetiredStorage = () => {
  RETIRED_STORAGE_KEYS.forEach((key) => {
    try {
      storage()?.removeItem(key);
    } catch {
      // Unavailable storage holds nothing to purge.
    }
  });
};

if (typeof window !== 'undefined') {
  // Another window (or the host's settings bootstrap) changed storage directly.
  window.addEventListener('storage', (event) => {
    if (event.storageArea && event.storageArea !== storage()) return;
    if (event.key == null) refreshAllPreferences();
    else if (findPreference(event.key)) notify(event.key);
  });
}

export const resetPreferenceStoreForTests = () => {
  listeners.clear();
  snapshots.clear();
  nativeCommits.clear();
};
