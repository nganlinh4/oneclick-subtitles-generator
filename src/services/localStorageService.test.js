import { persistDesktopSettings } from '../platform/settingsService';
import { syncLocalStorageToServer } from './localStorageService';

vi.mock('../platform/settingsService', () => ({
  persistDesktopSettings: vi.fn(),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  persistDesktopSettings.mockReset();
  global.fetch = vi.fn();
});

afterAll(() => {
  global.fetch = originalFetch;
});

it('uses native settings persistence in Tauri without contacting the legacy server', async () => {
  persistDesktopSettings.mockResolvedValue({ success: true });
  localStorage.setItem('theme', 'light');

  await expect(syncLocalStorageToServer()).resolves.toEqual({ success: true });
  expect(persistDesktopSettings).toHaveBeenCalledWith(localStorage);
  expect(global.fetch).not.toHaveBeenCalled();
});

it('propagates a missing native boundary without sending settings over HTTP', async () => {
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('gemini_api_key', 'legacy-server-key');
  const unavailable = new Error('This operation requires the desktop runtime');
  persistDesktopSettings.mockRejectedValue(unavailable);
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  await expect(syncLocalStorageToServer()).rejects.toBe(unavailable);
  expect(persistDesktopSettings).toHaveBeenCalledWith(localStorage);
  expect(global.fetch).not.toHaveBeenCalled();
  consoleError.mockRestore();
});
