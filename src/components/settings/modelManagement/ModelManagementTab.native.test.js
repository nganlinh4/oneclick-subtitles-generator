import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  cancelNarrationModelPackageOperation,
  getNarrationModelPackageStatus,
  installNarrationModelPackage,
  removeNarrationModelPackage,
} from '../../../services/modelService';
import { showErrorToast } from '../../../utils/toastUtils';
import { getF5ModelsStatus, installF5Model } from '../../../platform/f5ModelService';
import ModelManagementTab from './ModelManagementTab';

const i18nMocks = vi.hoisted(() => ({
  t: (_key, fallback, values = {}) => Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
    fallback
  ),
}));

vi.mock('../../../services/modelService', () => ({
  cancelNarrationModelPackageOperation: vi.fn(),
  getNarrationModelPackageStatus: vi.fn(),
  installNarrationModelPackage: vi.fn(),
  removeNarrationModelPackage: vi.fn(),
}));
vi.mock('../../../services/modelAvailabilityService', () => ({
  invalidateModelsCache: vi.fn(),
}));
vi.mock('../../../platform/f5ModelService', () => ({
  cancelF5Model: vi.fn(),
  getF5ModelsStatus: vi.fn(),
  installF5Model: vi.fn(),
  removeF5Model: vi.fn(),
}));
vi.mock('../../../utils/toastUtils', () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18nMocks.t }),
}));

const packageStatus = (overrides = {}) => ({
  model: { id: 'f5tts-v1-base', name: 'F5-TTS v1 Base', source: 'signed-package' },
  deliveryAvailable: true,
  installed: false,
  updateAvailable: false,
  state: 'missing',
  version: null,
  availableVersion: '1.0.0',
  installedBytes: 0,
  downloadBytes: 1024,
  availableInstalledBytes: 2048,
  operation: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  getNarrationModelPackageStatus.mockResolvedValue(packageStatus());
  installNarrationModelPackage.mockResolvedValue({ started: false, job: null });
  removeNarrationModelPackage.mockResolvedValue({ started: false, job: null });
  cancelNarrationModelPackageOperation.mockResolvedValue({ cancelled: false, job: null });
  getF5ModelsStatus.mockResolvedValue([]);
  installF5Model.mockResolvedValue(undefined);
});

it('starts the missing shared runtime and selected language model together', async () => {
  let releaseRuntime;
  let releaseModel;
  installNarrationModelPackage.mockReturnValue(new Promise((resolve) => { releaseRuntime = resolve; }));
  installF5Model.mockReturnValue(new Promise((resolve) => { releaseModel = resolve; }));
  getF5ModelsStatus.mockResolvedValue([{
    id: 'f5tts-vietnamese-vivoice', name: 'F5 Vietnamese ViVoice', author: 'hynt',
    language: 'vi', license: 'CC-BY-NC-SA-4.0', installed: false,
    downloadBytes: 5_394_373_461, operation: null,
  }]);
  render(<ModelManagementTab activeTab="model-management" />);

  const card = (await screen.findByText('F5 Vietnamese ViVoice')).closest('article');
  const install = card.querySelector('.download-model-btn');
  expect(install).toBeEnabled();
  fireEvent.click(install);
  await waitFor(() => {
    expect(installNarrationModelPackage).toHaveBeenCalledTimes(1);
    expect(installF5Model).toHaveBeenCalledWith('f5tts-vietnamese-vivoice', expect.any(Function));
  });
  releaseRuntime({ started: true, job: { id: 'runtime' } });
  releaseModel();
});

it('shows only the shipping signed package and invokes a URL-free install contract', async () => {
  const { container } = render(<ModelManagementTab activeTab="model-management" />);

  expect(await screen.findByText('F5-TTS v1 Base')).toBeInTheDocument();
  expect(container.querySelectorAll('[data-model-package-id]')).toHaveLength(1);
  expect(screen.queryByText(/custom model|hugging face|direct url/i)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Install' }));
  await waitFor(() => expect(installNarrationModelPackage).toHaveBeenCalledTimes(1));
  expect(installNarrationModelPackage.mock.calls[0]).toEqual([
    expect.objectContaining({
      onProgress: expect.any(Function),
      onCompleted: expect.any(Function),
      onFailed: expect.any(Function),
    }),
  ]);
  expect(JSON.stringify(installNarrationModelPackage.mock.calls)).not.toMatch(/(?:url|path)/i);
});

it('requires confirmation before removing an installed package', async () => {
  getNarrationModelPackageStatus.mockResolvedValue(packageStatus({
    installed: true,
    state: 'installed',
    version: '1.0.0',
    installedBytes: 2048,
  }));
  render(<ModelManagementTab activeTab="model-management" />);

  fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
  expect(removeNarrationModelPackage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() => expect(removeNarrationModelPackage).toHaveBeenCalledTimes(1));
});

it('offers repair for native corruption and cancel for the exact native operation', async () => {
  const operation = {
    action: 'install',
    phase: 'downloading',
    basisPoints: 2500,
    bytesDone: 25,
    totalBytes: 100,
    job: { id: 'native-job' },
  };
  getNarrationModelPackageStatus
    .mockResolvedValueOnce(packageStatus({ installed: true, state: 'corrupt', version: '1.0.0' }))
    .mockResolvedValue(packageStatus({ operation }));
  const { rerender } = render(<ModelManagementTab activeTab="model-management" />);

  expect(await screen.findByRole('button', { name: 'Repair' })).toBeInTheDocument();
  rerender(<ModelManagementTab activeTab="other" />);
  rerender(<ModelManagementTab activeTab="model-management" />);
  expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(cancelNarrationModelPackageOperation).toHaveBeenCalledWith());
});

it('does not query the native package while its settings tab is inactive', async () => {
  const { rerender } = render(<ModelManagementTab activeTab="cache" />);
  expect(getNarrationModelPackageStatus).not.toHaveBeenCalled();

  rerender(<ModelManagementTab activeTab="model-management" />);
  await waitFor(() => expect(getNarrationModelPackageStatus).toHaveBeenCalledTimes(1));
});

it('survives StrictMode effect replay and leaves a failed probe actionable', async () => {
  getNarrationModelPackageStatus.mockRejectedValue(new Error('native unavailable'));
  render(
    <StrictMode>
      <ModelManagementTab activeTab="model-management" />
    </StrictMode>
  );

  expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  expect(document.querySelector('[data-model-package-state="failed"]')).not.toBeNull();
});

it.each([
  ['packageInsufficientSpace', 'not enough disk space'],
  ['packageNetwork', 'could not be downloaded'],
  ['packageIntegrity', 'failed its integrity check'],
])('shows an actionable %s install failure instead of the generic dead end', async (code, message) => {
  installNarrationModelPackage.mockImplementation(async (handlers) => {
    handlers.onFailed({ error: { code, message: 'redacted native failure' } });
    return { started: true, job: { id: 'native-job' } };
  });
  render(<ModelManagementTab activeTab="model-management" />);

  fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

  await waitFor(() => expect(showErrorToast).toHaveBeenCalledWith(expect.stringContaining(message)));
  expect(showErrorToast).not.toHaveBeenCalledWith('The narration model operation failed.');
});
