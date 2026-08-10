import {
  getGitVersion,
  getLatestVersion,
} from './gitVersion';
import {
  checkDesktopUpdate,
  getDesktopAppVersion,
} from '../platform/updateService';

vi.mock('../platform/updateService', () => ({
  checkDesktopUpdate: vi.fn(),
  getDesktopAppVersion: vi.fn(),
}));

const originalTauri = window.isTauri;
const originalFetch = global.fetch;

beforeEach(() => {
  window.isTauri = true;
  global.fetch = vi.fn();
  getDesktopAppVersion.mockReset().mockResolvedValue('2.0.0');
  checkDesktopUpdate.mockReset();
});

afterAll(() => {
  window.isTauri = originalTauri;
  global.fetch = originalFetch;
});

test('desktop current version comes from the installed Tauri package without HTTP', async () => {
  await expect(getGitVersion()).resolves.toMatchObject({
    version: '2.0.0',
    branch: 'main',
    source: 'tauri-package',
  });
  expect(getDesktopAppVersion).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('desktop latest version comes from the signed updater contract without GitHub fetch', async () => {
  checkDesktopUpdate.mockResolvedValue({
    configured: true,
    currentVersion: '2.0.0',
    update: {
      version: '2.1.0',
      publishedAt: '2026-08-10T03:04:05Z',
      notes: 'Release notes',
    },
  });

  await expect(getLatestVersion()).resolves.toMatchObject({
    version: '2.1.0',
    date: '2026-08-10T03:04:05Z',
    message: 'Release notes',
    source: 'tauri-updater',
  });
  expect(checkDesktopUpdate).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('desktop reports the installed release when the signed endpoint has no update', async () => {
  checkDesktopUpdate.mockResolvedValue({
    configured: true,
    currentVersion: '2.0.0',
    update: null,
  });

  await expect(getLatestVersion()).resolves.toMatchObject({
    version: '2.0.0',
    source: 'tauri-updater-current',
  });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('desktop fails closed when no permanent update signing identity is configured', async () => {
  checkDesktopUpdate.mockResolvedValue({
    configured: false,
    currentVersion: '2.0.0',
    update: null,
  });

  await expect(getLatestVersion()).rejects.toThrow('Unable to fetch latest version information');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('browser builds preserve the legacy GitHub commit lookup', async () => {
  window.isTauri = false;
  global.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      sha: 'abcdef0123456789',
      html_url: 'https://github.com/nganlinh4/oneclick-subtitles-generator/commit/abcdef0',
      commit: {
        message: 'Browser release',
        committer: { date: '2026-08-10T03:04:05Z' },
        author: { name: 'OSG', email: 'osg@example.invalid' },
      },
    }),
  });

  await expect(getLatestVersion()).resolves.toMatchObject({
    shortHash: 'abcdef0',
    source: 'github-commits',
  });
  expect(global.fetch).toHaveBeenCalledWith(
    'https://api.github.com/repos/nganlinh4/oneclick-subtitles-generator/commits/main',
    expect.any(Object)
  );
  expect(checkDesktopUpdate).not.toHaveBeenCalled();
});
