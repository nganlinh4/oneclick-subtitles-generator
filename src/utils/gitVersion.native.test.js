import {
  getGitVersion,
  getLatestVersion,
} from './gitVersion';
import {
  checkDesktopUpdate,
  getDesktopAppVersion,
} from '../platform/updateService';
import * as updateCoordinator from '../platform/startupUpdateCoordinator';

vi.mock('../platform/updateService', () => ({
  checkDesktopUpdate: vi.fn(),
  getDesktopAppVersion: vi.fn(),
}));

const originalTauri = window.isTauri;
const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
  updateCoordinator.resetStartupUpdateCheckForTests();
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

test('desktop preserves an unavailable updater without claiming a latest release', async () => {
  checkDesktopUpdate.mockResolvedValue({
    configured: false,
    currentVersion: '2.0.0',
    update: null,
  });

  await expect(getLatestVersion()).resolves.toEqual({
    configured: false,
    source: 'tauri-updater-unavailable',
  });
  expect(global.fetch).not.toHaveBeenCalled();
});

test('About keeps a disabled update channel neutral and still shows the installed version', async () => {
  checkDesktopUpdate.mockResolvedValue({ configured: false, currentVersion: '2.0.0', update: null });
  const { container } = render(<AboutTab />);

  await screen.findByText(/v2.0.0/);
  await waitFor(() => expect(container.querySelector('.checking-update')).toBeNull());
  expect(screen.queryByText('Unable to check for updates')).not.toBeInTheDocument();
  expect(screen.queryByText('You are using the latest version!')).not.toBeInTheDocument();
  expect(container.querySelector('.latest-version-info')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('About still reports a genuine updater failure', async () => {
  checkDesktopUpdate.mockRejectedValue(new Error('endpoint unavailable'));
  render(<AboutTab />);

  expect(await screen.findByText('Unable to check for updates')).toBeInTheDocument();
  expect(screen.queryByText('You are using the latest version!')).not.toBeInTheDocument();
});

test('About offers the native install action instead of obsolete script instructions', async () => {
  const install = vi.spyOn(updateCoordinator, 'beginDesktopUpdateInstall').mockImplementation(() => {});
  checkDesktopUpdate.mockResolvedValue({
    configured: true,
    currentVersion: '2.0.0',
    update: { version: '2.1.0', publishedAt: '2026-09-12T00:00:00Z', notes: null },
  });
  const { container } = render(<AboutTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'Install update' }));

  expect(install).toHaveBeenCalledExactlyOnceWith({ version: '2.1.0' });
  expect(container).not.toHaveTextContent('OSG_installer_Windows.bat');
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
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AboutTab from '../components/settings/tabs/AboutTab';
