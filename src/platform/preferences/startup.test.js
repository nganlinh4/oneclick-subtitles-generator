import { prepareStoredPreferences } from './startup';
import { resetPreferenceStoreForTests } from './store';

const host = vi.hoisted(() => ({ desktop: true, invoke: null }));

vi.mock('../desktopRuntime', () => ({
  isDesktopRuntime: () => host.desktop,
  invokeDesktop: (...args) => host.invoke(...args),
}));

beforeEach(() => {
  localStorage.clear();
  resetPreferenceStoreForTests();
  host.invoke = vi.fn(async () => undefined);
});

test('purges retired keys and commits a migrated native model id to SQLite', async () => {
  localStorage.setItem('current_file_url', 'http://127.0.0.1:1/asset?token=private');
  localStorage.setItem('gemini_model', 'gemini-pro');

  prepareStoredPreferences();

  expect(localStorage.getItem('current_file_url')).toBeNull();
  expect(localStorage.getItem('gemini_model')).toBe('gemini-3.1-flash-lite');
  await vi.waitFor(() => expect(host.invoke).toHaveBeenCalledWith('setting_set', {
    key: 'gemini_model',
    value: 'gemini-3.1-flash-lite',
  }));
});

test('leaves current values alone and commits nothing', () => {
  localStorage.setItem('gemini_model', 'gemini-3.1-flash-lite');

  prepareStoredPreferences();

  expect(localStorage.getItem('gemini_model')).toBe('gemini-3.1-flash-lite');
  expect(host.invoke).not.toHaveBeenCalled();
});
