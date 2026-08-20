import { clearCache } from '../../platform/cacheService';
import { clearCredentials } from '../../platform/credentialStateController';
import { clearMedia } from '../../platform/mediaService';
import { clearDesktopSettings } from '../../platform/settingsService';
import { clearNativeApplicationState } from './SettingsModal';

vi.mock('../../platform/cacheService', () => ({ clearCache: vi.fn() }));
vi.mock('../../platform/credentialStateController', async (importOriginal) => ({
  ...(await importOriginal()),
  clearCredentials: vi.fn(),
}));
vi.mock('../../platform/mediaService', () => ({ clearMedia: vi.fn() }));
vi.mock('../../platform/settingsService', () => ({ clearDesktopSettings: vi.fn() }));

beforeEach(() => {
  clearCache.mockResolvedValue({ success: true });
  clearCredentials.mockResolvedValue(undefined);
  clearMedia.mockResolvedValue(0);
  clearDesktopSettings.mockResolvedValue(0);
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
  delete global.fetch;
});

it('clears every native state owner without contacting a legacy reset endpoint', async () => {
  await expect(clearNativeApplicationState()).resolves.toEqual([
    { success: true },
    undefined,
    0,
    0,
  ]);

  expect(clearCache).toHaveBeenCalledWith();
  expect(clearCredentials).toHaveBeenCalledWith();
  expect(clearMedia).toHaveBeenCalledWith();
  expect(clearDesktopSettings).toHaveBeenCalledWith();
  expect(global.fetch).not.toHaveBeenCalled();
});
