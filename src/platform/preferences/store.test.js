import { act, renderHook } from '@testing-library/react';

import {
  clearPreference,
  commitNativePreferences,
  hasStoredPreference,
  purgeRetiredStorage,
  readPreference,
  readStoredPreference,
  resetPreferenceStoreForTests,
  subscribePreference,
  usePreference,
  writePreference,
} from './store';

const host = vi.hoisted(() => ({ invoke: null }));

vi.mock('../desktopRuntime', () => ({
  invokeDesktop: (...args) => host.invoke(...args),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferenceStoreForTests();
  host.invoke = vi.fn(async () => undefined);
});

test('reads declared defaults and keeps the stored string formats', () => {
  expect(readPreference('time_format')).toBe('hms');
  expect(readPreference('show_favorite_max_length')).toBe(true);
  expect(readPreference('video_processing_max_words')).toBe(12);
  expect(hasStoredPreference('time_format')).toBe(false);

  writePreference('video_processing_max_words', 9);
  writePreference('show_favorite_max_length', false);
  writePreference('custom_gemini_models', [{ id: 'model-a' }]);

  expect(localStorage.getItem('video_processing_max_words')).toBe('9');
  expect(localStorage.getItem('show_favorite_max_length')).toBe('false');
  expect(localStorage.getItem('custom_gemini_models')).toBe('[{"id":"model-a"}]');
});

test('decodes damaged values to the default and clamps numbers', () => {
  localStorage.setItem('time_format', 'fortnights');
  localStorage.setItem('video_processing_fps', '999');
  localStorage.setItem('custom_gemini_models', '{not json');
  localStorage.setItem('show_favorite_max_length', 'yes');

  expect(readPreference('time_format')).toBe('hms');
  expect(readPreference('video_processing_fps')).toBe(5);
  expect(readPreference('custom_gemini_models')).toEqual([]);
  expect(readPreference('show_favorite_max_length')).toBe(true);
});

test('refuses undeclared keys and values the codec cannot represent', () => {
  expect(() => readPreference('not_a_preference')).toThrow(TypeError);
  expect(() => writePreference('time_format', 'fortnights')).toThrow(TypeError);
  expect(() => writePreference('show_favorite_max_length', 'true')).toThrow(TypeError);
  expect(localStorage.getItem('time_format')).toBeNull();
});

test('returns a stable snapshot for unchanged JSON values', () => {
  localStorage.setItem('custom_gemini_models', '[{"id":"a"}]');
  expect(readPreference('custom_gemini_models')).toBe(readPreference('custom_gemini_models'));
});

test('notifies subscribers of writes in this window and storage events from others', () => {
  const listener = vi.fn();
  const unsubscribe = subscribePreference('time_format', listener);

  writePreference('time_format', 'seconds');
  expect(listener).toHaveBeenCalledTimes(1);

  window.dispatchEvent(new StorageEvent('storage', { key: 'time_format' }));
  expect(listener).toHaveBeenCalledTimes(2);

  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(listener).toHaveBeenCalledTimes(3);

  unsubscribe();
  writePreference('time_format', 'hms');
  expect(listener).toHaveBeenCalledTimes(3);
});

test('usePreference renders the stored value and writes through the store', () => {
  const { result } = renderHook(() => usePreference('video_processing_fps'));
  expect(result.current[0]).toBe(0.25);

  act(() => { result.current[1]((current) => current + 1); });
  expect(result.current[0]).toBe(1.25);
  expect(localStorage.getItem('video_processing_fps')).toBe('1.25');
});

test('a native write updates at once and commits the setting to SQLite', async () => {

  await expect(writePreference('time_format', 'seconds')).resolves.toBe(true);

  expect(localStorage.getItem('time_format')).toBe('seconds');
  expect(host.invoke).toHaveBeenCalledExactlyOnceWith('setting_set', {
    key: 'time_format',
    value: 'seconds',
  });
});

test('a refused native write restores the last committed value', async () => {
  localStorage.setItem('video_processing_max_words', '12');
  host.invoke = vi.fn(async () => { throw new Error('settingsWriteRefused'); });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  const pending = writePreference('video_processing_max_words', 20);
  expect(readPreference('video_processing_max_words')).toBe(20);

  await expect(pending).resolves.toBe(false);
  expect(readPreference('video_processing_max_words')).toBe(12);
  warn.mockRestore();
});

test('rapid native writes coalesce to the latest value', async () => {
  let release;
  host.invoke = vi.fn(() => new Promise((resolve) => { release = resolve; }));

  const first = writePreference('video_processing_max_words', 5);
  writePreference('video_processing_max_words', 6);
  writePreference('video_processing_max_words', 7);
  release();
  await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledTimes(2));
  release();

  await expect(first).resolves.toBe(true);
  expect(host.invoke.mock.calls.map(([, { value }]) => value)).toEqual(['5', '7']);
  expect(localStorage.getItem('video_processing_max_words')).toBe('7');
});

test('a Settings save commits the batch natively before updating the mirror', async () => {
  const listener = vi.fn();
  subscribePreference('time_format', listener);
  host.invoke = vi.fn(async () => {
    expect(localStorage.getItem('time_format')).toBeNull();
  });

  await commitNativePreferences({ time_format: 'seconds', show_favorite_max_length: false });

  expect(host.invoke).toHaveBeenCalledExactlyOnceWith('settings_set_many', {
    values: { time_format: 'seconds', show_favorite_max_length: 'false' },
  });
  expect(localStorage.getItem('time_format')).toBe('seconds');
  expect(listener).toHaveBeenCalledTimes(1);
});

test('a Settings save accepts only native preferences', async () => {
  await expect(commitNativePreferences({ video_processing_fps: 1 })).rejects.toThrow(TypeError);
  expect(() => clearPreference('time_format')).toThrow(TypeError);
});

test('purges the retired browser-era media keys', () => {
  localStorage.setItem('current_file_url', 'http://127.0.0.1:1/asset?token=private');
  localStorage.setItem('current_video_url', 'https://example.test/watch');
  localStorage.setItem('time_format', 'seconds');

  purgeRetiredStorage();

  expect(localStorage.getItem('current_file_url')).toBeNull();
  expect(localStorage.getItem('current_video_url')).toBeNull();
  expect(localStorage.getItem('time_format')).toBe('seconds');
});

test('distinguishes a canonical stored value from a missing or damaged one', () => {
  expect(readStoredPreference('theme')).toBeNull();
  localStorage.setItem('theme', 'blue');
  expect(readStoredPreference('theme')).toBeNull();
  localStorage.setItem('theme', 'light');
  expect(readStoredPreference('theme')).toBe('light');
});

test('declares one codec for every engine-keyed ASR option', () => {
  expect(readPreference('asr_some-engine.v2_max_chars')).toBe(60);
  writePreference('asr_some-engine.v2_max_chars', 200);
  expect(localStorage.getItem('asr_some-engine.v2_max_chars')).toBe('100');
  expect(() => readPreference('asr_some-engine_unknown_option')).toThrow(TypeError);
});
