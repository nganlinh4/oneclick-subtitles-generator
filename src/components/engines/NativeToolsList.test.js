import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  getNativeToolsCatalog,
  getNativeToolsStatus,
  removeNativeTool,
} from '../../platform/nativeToolsService';
import NativeToolsList, { NativeToolRow } from './NativeToolsList';
import { getRenderPackageStatus } from '../../platform/renderPackageService';
import { getVoiceSamplesStatus } from '../../platform/voiceSampleService';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values) => {
      const translated = ({
      'engines.nativeKind.media': 'Media processing',
      'engines.nativeKind.downloader': 'Site downloader',
      'engines.nativeKind.renderer': 'Video renderer',
      'engines.nativeKind.voicePreviews': 'Voice previews',
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
vi.mock('../../platform/voiceSampleService', () => ({
  cancelVoiceSamples: vi.fn(),
  getVoiceSamplesStatus: vi.fn(),
  installVoiceSamples: vi.fn(),
  removeVoiceSamples: vi.fn(),
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

const renderStatus = (overrides = {}) => ({
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
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

afterEach(() => vi.clearAllMocks());

beforeEach(() => {
  getVoiceSamplesStatus.mockResolvedValue({
    id: 'gemini-voice-samples',
    label: 'Gemini voice previews',
    deliveryAvailable: true,
    installed: false,
    updateAvailable: false,
    state: 'missing',
    version: null,
    availableVersion: '2026.08.11',
    installedBytes: 0,
    downloadBytes: 13_520_118,
    availableInstalledBytes: 16_384_680,
  });
});

it('shows source, license, version, and a confirmed native removal action', async () => {
  let handlers;
  removeNativeTool.mockImplementation(async (_tool, suppliedHandlers) => {
    handlers = suppliedHandlers;
    return { id: 'job' };
  });
  const onChanged = vi.fn();
  const { container } = render(
    <NativeToolRow catalog={catalog} status={status()} onChanged={onChanged} />
  );

  expect(container.querySelector('[data-native-tool-id="yt-dlp"]')).not.toBeNull();
  expect(screen.getByText(/Official release · GPL-3\.0-or-later · v2026\.07\.04/))
    .toBeInTheDocument();
  expect(screen.getByText('Installed and active · 17 MB disk')).toBeInTheDocument();
  const removeRequest = container.querySelector('[data-tool-action="remove-request"]');
  expect(removeRequest).not.toBeNull();
  fireEvent.click(removeRequest);
  const removeConfirm = container.querySelector('[data-tool-action="remove-confirm"]');
  expect(removeConfirm).not.toBeNull();
  fireEvent.click(removeConfirm);
  expect(removeNativeTool).toHaveBeenCalledWith('yt-dlp', expect.any(Object));
  handlers.onCompleted();
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

it('trusts verified terminal status after a late channel protocol error', async () => {
  let handlers;
  removeNativeTool.mockImplementation(async (_tool, suppliedHandlers) => {
    handlers = suppliedHandlers;
    return { id: 'job' };
  });
  getNativeToolsStatus.mockResolvedValue({
    schemaVersion: 1,
    tools: [status({
      installed: false,
      state: 'missing',
      version: null,
      installedBytes: 0,
      activeRuntime: false,
    })],
  });
  const onChanged = vi.fn();
  render(<NativeToolRow catalog={catalog} status={status()} onChanged={onChanged} />);

  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
  fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
  await handlers.onProtocolError();

  expect(screen.queryByText('The desktop host returned invalid tool progress.'))
    .not.toBeInTheDocument();
  expect(onChanged).toHaveBeenCalled();
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
  getRenderPackageStatus.mockResolvedValue(renderStatus());
  render(<NativeToolsList />);
  expect(await screen.findByText('Remotion video renderer')).toBeInTheDocument();
  expect(screen.getByText(/Video renderer · Reviewed bundle pool/)).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
  expect(screen.getByText('Gemini voice previews')).toBeInTheDocument();
  expect(screen.getByText(/Voice previews · Reviewed bundle pool · Provider terms/))
    .toBeInTheDocument();
});

it('ignores a stale refresh that resolves after a newer native-tool snapshot', async () => {
  const firstCatalog = deferred();
  const firstStatus = deferred();
  const firstRender = deferred();
  const firstVoice = deferred();
  const missingTool = status({
    installed: false,
    state: 'missing',
    version: null,
    installedBytes: 0,
    activeRuntime: false,
  });
  getNativeToolsCatalog
    .mockReturnValueOnce(firstCatalog.promise)
    .mockResolvedValue({ schemaVersion: 1, tools: [catalog] });
  getNativeToolsStatus
    .mockReturnValueOnce(firstStatus.promise)
    .mockResolvedValue({ schemaVersion: 1, tools: [missingTool] });
  getRenderPackageStatus
    .mockReturnValueOnce(firstRender.promise)
    .mockResolvedValue(renderStatus());
  getVoiceSamplesStatus
    .mockReturnValueOnce(firstVoice.promise)
    .mockResolvedValue({
      id: 'gemini-voice-samples',
      label: 'Gemini voice previews',
      deliveryAvailable: true,
      installed: false,
      updateAvailable: false,
      state: 'missing',
      version: null,
      availableVersion: '2026.08.11',
      installedBytes: 0,
      downloadBytes: 13_520_118,
      availableInstalledBytes: 16_384_680,
    });

  const { container } = render(<NativeToolsList />);
  await waitFor(() => expect(getNativeToolsStatus).toHaveBeenCalledTimes(1));
  fireEvent.focus(window);
  await waitFor(() => expect(getNativeToolsStatus).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(
    container.querySelector('[data-native-tool-id="yt-dlp"]')
  ).toHaveClass('engine-card--missing'));
  expect(container.querySelector(
    '[data-native-tool-id="yt-dlp"] [data-tool-action="install"]'
  )).not.toBeNull();

  await act(async () => {
    firstCatalog.resolve({ schemaVersion: 1, tools: [catalog] });
    firstStatus.resolve({ schemaVersion: 1, tools: [status()] });
    firstRender.resolve(renderStatus({ installed: true, state: 'installed' }));
    firstVoice.resolve({
      id: 'gemini-voice-samples',
      label: 'Gemini voice previews',
      deliveryAvailable: true,
      installed: true,
      updateAvailable: false,
      state: 'installed',
      version: '2026.08.11',
      availableVersion: '2026.08.11',
      installedBytes: 16_384_680,
      downloadBytes: 13_520_118,
      availableInstalledBytes: 16_384_680,
    });
    await Promise.all([
      firstCatalog.promise, firstStatus.promise, firstRender.promise, firstVoice.promise,
    ]);
  });

  expect(container.querySelector('[data-native-tool-id="yt-dlp"]'))
    .toHaveClass('engine-card--missing');
});
