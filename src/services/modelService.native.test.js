import { v7 as uuidv7 } from 'uuid';

const packageMocks = vi.hoisted(() => ({
  cancelSpeechPackageJob: vi.fn(),
  getSpeechPackagesStatus: vi.fn(),
  installSpeechPackage: vi.fn(),
  removeSpeechPackage: vi.fn(),
}));

vi.mock('../platform/speechPackageService', () => packageMocks);

import {
  cancelNarrationModelPackageOperation,
  getModels,
  getNarrationModelPackageStatus,
  installNarrationModelPackage,
  removeNarrationModelPackage,
} from './modelService';

const f5Package = (overrides = {}) => ({
  id: 'f5-tts',
  label: 'F5-TTS',
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

const status = (entry) => ({ schemaVersion: 1, packages: [entry] });

beforeEach(() => vi.clearAllMocks());

it('publishes only the signed F5-TTS package and no transport locations', async () => {
  packageMocks.getSpeechPackagesStatus.mockResolvedValue(status(f5Package({
    installed: true,
    state: 'installed',
    version: '1.0.0',
    installedBytes: 2048,
  })));

  await expect(getNarrationModelPackageStatus()).resolves.toMatchObject({
    model: { id: 'f5tts-v1-base', source: 'signed-package' },
    installed: true,
    state: 'installed',
  });
  const models = await getModels();
  expect(models.models).toHaveLength(1);
  expect(JSON.stringify(models)).not.toMatch(/(?:url|path)/i);
});

it('installs through the fixed native package binding without accepting URL-shaped input', async () => {
  const job = { id: uuidv7(), kind: 'installEngine', state: 'running', progress: { basisPoints: 125 }, sequence: 1 };
  packageMocks.getSpeechPackagesStatus.mockResolvedValue(status(f5Package()));
  packageMocks.installSpeechPackage.mockResolvedValue(job);

  await expect(installNarrationModelPackage()).resolves.toEqual({ started: true, job });
  expect(packageMocks.installSpeechPackage).toHaveBeenCalledWith('f5-tts', {});

  await expect(installNarrationModelPackage({ modelUrl: 'https://example.invalid/model' }))
    .rejects.toMatchObject({ code: 'invalidModelRequest' });
  expect(packageMocks.installSpeechPackage).toHaveBeenCalledTimes(1);
});

it('repairs corrupt packages, no-ops for current installs, and removes only the signed package', async () => {
  const job = { id: uuidv7(), kind: 'installEngine', state: 'running', progress: { basisPoints: 0 }, sequence: 1 };
  packageMocks.installSpeechPackage.mockResolvedValue(job);
  packageMocks.removeSpeechPackage.mockResolvedValue(job);

  packageMocks.getSpeechPackagesStatus.mockResolvedValueOnce(status(f5Package({
    installed: true, state: 'corrupt', version: '1.0.0', installedBytes: 2048,
  })));
  await expect(installNarrationModelPackage()).resolves.toMatchObject({ started: true });

  packageMocks.getSpeechPackagesStatus.mockResolvedValueOnce(status(f5Package({
    installed: true, state: 'installed', version: '1.0.0', installedBytes: 2048,
  })));
  await expect(installNarrationModelPackage()).resolves.toEqual({ started: false, job: null });

  packageMocks.getSpeechPackagesStatus.mockResolvedValueOnce(status(f5Package({
    installed: true, state: 'installed', version: '1.0.0', installedBytes: 2048,
  })));
  await expect(removeNarrationModelPackage()).resolves.toMatchObject({ started: true });
  expect(packageMocks.removeSpeechPackage).toHaveBeenCalledWith('f5-tts', {});
});

it('cancels only the operation reported by the native status snapshot', async () => {
  const job = { id: uuidv7(), kind: 'installEngine', state: 'running', progress: { basisPoints: 500 }, sequence: 2 };
  packageMocks.getSpeechPackagesStatus.mockResolvedValue(status(f5Package({
    operation: { job, backend: 'f5-tts', action: 'install', phase: 'downloading', basisPoints: 500, bytesDone: 50, totalBytes: 100 },
  })));
  packageMocks.cancelSpeechPackageJob.mockResolvedValue({ ...job, state: 'cancelling' });

  await expect(cancelNarrationModelPackageOperation()).resolves.toMatchObject({ cancelled: true });
  expect(packageMocks.cancelSpeechPackageJob).toHaveBeenCalledWith(job.id);
});
