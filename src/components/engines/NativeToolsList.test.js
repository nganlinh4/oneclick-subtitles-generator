import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  getNativeToolsCatalog,
  getNativeToolsStatus,
  removeNativeTool,
} from '../../platform/nativeToolsService';
import NativeToolsList, { NativeToolRow } from './NativeToolsList';
import { getRenderPackageStatus } from '../../platform/renderPackageService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) => {
      const translated = ({
      'engines.nativeKind.media': 'Media processing',
      'engines.nativeKind.downloader': 'Site downloader',
      'engines.nativeKind.renderer': 'Video renderer',
      'engines.nativeSource.vendor': 'Reviewed vendor',
      'engines.nativeSource.official': 'Official release',
      'engines.nativeSource.pool': 'Reviewed bundle pool',
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
vi.mock('../../platform/renderPackageService', () => ({
  cancelRenderPackageJob: vi.fn(),
  getRenderPackageStatus: vi.fn(),
  installRenderPackage: vi.fn(),
  removeRenderPackage: vi.fn(),
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

it('surfaces a native schema or IPC failure with a compact retry action', async () => {
  getNativeToolsCatalog.mockRejectedValue(new Error('old desktop host'));
  getNativeToolsStatus.mockRejectedValue(new Error('old desktop host'));

  render(<NativeToolsList />);

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The desktop runtime did not return tool status.'
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(getNativeToolsStatus).toHaveBeenCalledTimes(2));
});

it('exposes the downloadable renderer beside the native tools', async () => {
  getNativeToolsCatalog.mockResolvedValue({ schemaVersion: 1, tools: [catalog] });
  getNativeToolsStatus.mockResolvedValue({ schemaVersion: 1, tools: [status()] });
  getRenderPackageStatus.mockResolvedValue({
    schemaVersion: 1,
    id: 'remotion-runtime',
    label: 'Remotion video renderer',
    deliveryAvailable: true,
    installed: false,
    updateAvailable: false,
    state: 'missing',
    version: null,
    availableVersion: '4.0.507',
    installedBytes: 0,
    downloadBytes: 265_442_457,
    availableInstalledBytes: 624_910_330,
    operation: null,
  });
  render(<NativeToolsList />);
  expect(await screen.findByText('Remotion video renderer')).toBeInTheDocument();
  expect(screen.getByText(/Reviewed bundle pool/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
});
