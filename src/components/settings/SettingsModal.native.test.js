import { clearCache } from '../../platform/cacheService';
import { clearCredentials } from '../../platform/credentialStateController';
import { clearMedia } from '../../platform/mediaService';
import { forgetNativeMediaSessionDurably } from '../../platform/nativeMediaOwnership';
import { clearDesktopSettings } from '../../platform/settingsService';
import {
  clearApplicationStateAndReload,
  clearBrowserApplicationState,
  clearNativeApplicationState,
} from './SettingsModal';

vi.mock('../../platform/cacheService', () => ({ clearCache: vi.fn() }));
vi.mock('../../platform/credentialStateController', async (importOriginal) => ({
  ...(await importOriginal()),
  clearCredentials: vi.fn(),
}));
vi.mock('../../platform/mediaService', async (importOriginal) => ({
  ...(await importOriginal()),
  clearMedia: vi.fn(),
}));
vi.mock('../../platform/settingsService', () => ({ clearDesktopSettings: vi.fn() }));
vi.mock('../../platform/nativeMediaOwnership', async (importOriginal) => ({
  ...(await importOriginal()),
  forgetNativeMediaSessionDurably: vi.fn(),
}));

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

it('clears resettable native state without contacting a legacy endpoint or workspace owner', async () => {
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
  expect(forgetNativeMediaSessionDurably).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

it('waits for every named IndexedDB deletion after clearing the browser mirror', async () => {
  const storage = { clear: vi.fn() };
  const requests = new Map();
  const indexedDb = {
    databases: vi.fn().mockResolvedValue([
      { name: 'preview-cache' },
      { name: '' },
      {},
      { name: 'render-cache' },
    ]),
    deleteDatabase: vi.fn((name) => {
      const request = {};
      requests.set(name, request);
      return request;
    }),
  };

  let settled = false;
  const clearing = clearBrowserApplicationState({ storage, indexedDb })
    .then(() => { settled = true; });
  await vi.waitFor(() => expect(storage.clear).toHaveBeenCalledOnce());

  expect(indexedDb.deleteDatabase.mock.calls).toEqual([
    ['preview-cache'],
    ['render-cache'],
  ]);
  expect(settled).toBe(false);

  requests.get('preview-cache').onsuccess();
  await Promise.resolve();
  expect(settled).toBe(false);
  requests.get('render-cache').onsuccess();
  await clearing;
  expect(settled).toBe(true);
});

it('does not finish a rejected native reset while another native clear is still running', async () => {
  let finishSettingsClear;
  clearCache.mockRejectedValue(new Error('cache clear refused'));
  clearDesktopSettings.mockReturnValueOnce(new Promise((resolve) => {
    finishSettingsClear = resolve;
  }));

  let settled = false;
  const clearing = clearNativeApplicationState().finally(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();

  expect(settled).toBe(false);
  finishSettingsClear(0);
  await expect(clearing).rejects.toThrow('cache clear refused');
  expect(clearCache).toHaveBeenCalledTimes(2);
  expect(settled).toBe(true);
});

it('waits for all IndexedDB requests before surfacing one deletion failure', async () => {
  const requests = new Map();
  const indexedDb = {
    databases: vi.fn().mockResolvedValue([{ name: 'failed' }, { name: 'slow' }]),
    deleteDatabase: vi.fn((name) => {
      const request = {};
      const namedRequests = requests.get(name) ?? [];
      namedRequests.push(request);
      requests.set(name, namedRequests);
      return request;
    }),
  };

  let settled = false;
  const clearing = clearBrowserApplicationState({
    storage: { clear: vi.fn() },
    indexedDb,
  }).finally(() => { settled = true; });
  await vi.waitFor(() => expect(requests.has('failed')).toBe(true));

  requests.get('failed')[0].error = new Error('delete refused');
  requests.get('failed')[0].onerror();
  await Promise.resolve();
  expect(settled).toBe(false);

  requests.get('slow')[0].onsuccess();
  await vi.waitFor(() => expect(requests.get('failed')).toHaveLength(2));
  expect(indexedDb.deleteDatabase.mock.calls).toEqual([
    ['failed'],
    ['slow'],
    ['failed'],
  ]);
  requests.get('failed')[1].error = new Error('delete refused again');
  requests.get('failed')[1].onerror();
  await expect(clearing).rejects.toThrow('delete refused');
  expect(settled).toBe(true);
});

it('requests document replacement after bounded partial-reset failure', async () => {
  const nativeFailure = new Error('native clear refused');
  const clearNative = vi.fn().mockRejectedValue(nativeFailure);
  let finishBrowser;
  const clearBrowser = vi.fn(() => new Promise((resolve) => {
    finishBrowser = resolve;
  }));
  const reload = vi.fn();

  let settled = false;
  const reset = clearApplicationStateAndReload({
    clearNative,
    clearBrowser,
    reload,
  }).finally(() => { settled = true; });
  await Promise.resolve();
  expect(reload).not.toHaveBeenCalled();
  expect(settled).toBe(false);

  finishBrowser();
  await expect(reset).rejects.toBe(nativeFailure);
  expect(clearNative).toHaveBeenCalledTimes(2);
  expect(clearBrowser).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
  expect(settled).toBe(true);
});
