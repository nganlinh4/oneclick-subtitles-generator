import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  cancelNarrationModelPackageOperation,
  getNarrationModelPackageStatus,
  installNarrationModelPackage,
  removeNarrationModelPackage,
} from '../../../services/modelService';
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
