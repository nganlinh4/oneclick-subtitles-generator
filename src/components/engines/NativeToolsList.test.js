import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { removeNativeTool } from '../../platform/nativeToolsService';
import { NativeToolRow } from './NativeToolsList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) => {
      const translated = ({
      'engines.nativeKind.media': 'Media processing',
      'engines.nativeKind.downloader': 'Site downloader',
      'engines.nativeSource.vendor': 'Reviewed vendor',
      'engines.nativeSource.official': 'Official release',
      'engines.nativeState.installed': 'Installed and active',
      'engines.nativeState.unavailable': 'No reviewed release for this platform',
      })[key] || fallback || key;
      return values ? Object.entries(values).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, value),
        translated
      ) : translated;
    },
  }),
}));
vi.mock('../../platform/nativeToolsService', () => ({
  cancelNativeToolJob: vi.fn(),
  getNativeToolsCatalog: vi.fn(),
  getNativeToolsStatus: vi.fn(),
  installNativeTool: vi.fn(),
  removeNativeTool: vi.fn(),
}));

const catalog = {
  id: 'yt-dlp',
  label: 'yt-dlp',
  license: 'GPL-3.0-or-later',
};

const status = (overrides = {}) => ({
  id: 'yt-dlp',
  label: 'yt-dlp',
  deliveryAvailable: true,
  installed: true,
  state: 'installed',
  version: '2026.07.04',
  availableVersion: '2026.07.04',
  installedBytes: 18_226_085,
  downloadBytes: 18_226_085,
  availableInstalledBytes: 18_226_085,
  activeRuntime: true,
  pendingRemoval: false,
  restartRequired: false,
  operation: null,
  ...overrides,
});

afterEach(() => vi.clearAllMocks());

it('shows source, license, version, and a confirmed native removal action', async () => {
  let handlers;
  removeNativeTool.mockImplementation(async (_tool, suppliedHandlers) => {
    handlers = suppliedHandlers;
    return { id: 'job' };
  });
  const onChanged = vi.fn();
  render(<NativeToolRow catalog={catalog} status={status()} onChanged={onChanged} />);

  expect(screen.getByText(/Official release · GPL-3\.0-or-later · v2026\.07\.04/))
    .toBeInTheDocument();
  expect(screen.getByText('Installed and active · 17 MB disk')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
  expect(removeNativeTool).toHaveBeenCalledWith('yt-dlp', expect.any(Object));
  handlers.onCompleted();
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it('shows an unavailable tool without any fake download button', () => {
  render(
    <NativeToolRow
      catalog={{ ...catalog, id: 'media-tools', label: 'FFmpeg and FFprobe' }}
      status={status({
        id: 'media-tools',
        label: 'FFmpeg and FFprobe',
        deliveryAvailable: false,
        installed: false,
        state: 'unavailable',
        version: null,
        availableVersion: null,
        installedBytes: 0,
        downloadBytes: 0,
        availableInstalledBytes: 0,
        activeRuntime: false,
      })}
      onChanged={vi.fn()}
    />
  );

  expect(screen.getByText('Not published')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
});
