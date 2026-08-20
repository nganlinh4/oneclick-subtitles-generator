import { v7 as uuidv7 } from 'uuid';

const packageMocks = vi.hoisted(() => ({
  cancelSpeechPackageJob: vi.fn(),
  getSpeechPackagesStatus: vi.fn(),
  installSpeechPackage: vi.fn(),
  removeSpeechPackage: vi.fn(),
}));

vi.mock('../platform/speechPackageService', () => packageMocks);

import {
  addModelFromHuggingFace,
  addModelFromUrl,
  getModelServiceStatus,
  getModels,
} from './modelService';

const f5Package = (overrides = {}) => ({
  id: 'f5-tts',
  label: 'F5-TTS',
  deliveryAvailable: false,
  installed: false,
  updateAvailable: false,
  state: 'unavailable',
  version: null,
  availableVersion: null,
  installedBytes: 0,
  operation: null,
  ...overrides,
});

const status = (entry) => ({ schemaVersion: 1, packages: [entry] });

beforeEach(() => {
  vi.clearAllMocks();
});

it('reports an empty managed catalog as explicitly unavailable', async () => {
  packageMocks.getSpeechPackagesStatus.mockResolvedValue(status(f5Package()));

  await expect(getModelServiceStatus()).resolves.toEqual({
    available: false,
    installed: false,
    state: 'unavailable',
    operation: null,
  });
  await expect(getModels()).resolves.toEqual({
    models: [],
    active_model: null,
    package_state: 'unavailable',
  });
});

it('exposes installed package metadata without filesystem locations', async () => {
  const privatePath = 'C:\\Users\\person\\private-model.bin';
  packageMocks.getSpeechPackagesStatus.mockResolvedValue(status(f5Package({
    deliveryAvailable: true,
    installed: true,
    state: 'installed',
    version: '1.0.0',
    availableVersion: '1.0.0',
    installedBytes: 1_024,
  })));

  const result = await getModels();
  expect(result.models).toHaveLength(1);
  expect(result.models[0]).toEqual(expect.objectContaining({
    id: 'f5tts-v1-base',
    source: 'default',
    version: '1.0.0',
  }));
  expect(result.models[0]).not.toHaveProperty('model_path');
  expect(result.models[0]).not.toHaveProperty('vocab_path');
  expect(JSON.stringify(result)).not.toContain(privatePath);
});

it('maps the signed default model to the native package without forwarding URLs', async () => {
  const job = {
    id: uuidv7(),
    kind: 'installEngine',
    state: 'running',
    progress: { basisPoints: 125 },
    sequence: 1,
  };
  packageMocks.getSpeechPackagesStatus.mockResolvedValue(status(f5Package({
    deliveryAvailable: true,
    state: 'missing',
    availableVersion: '1.0.0',
  })));
  packageMocks.installSpeechPackage.mockResolvedValue(job);
  const privateUrl = 'https://user:secret@example.invalid/private-model.bin';

  await expect(addModelFromHuggingFace({
    modelId: 'f5tts-v1-base',
    modelUrl: privateUrl,
    vocabUrl: 'https://example.invalid/private-vocab.txt',
    languageCodes: ['en'],
    config: {},
  })).resolves.toEqual({
    success: true,
    model_id: 'f5tts-v1-base',
    job_id: job.id,
  });

  expect(packageMocks.installSpeechPackage).toHaveBeenCalledTimes(1);
  expect(packageMocks.installSpeechPackage.mock.calls[0][0]).toBe('f5-tts');
  expect(packageMocks.installSpeechPackage.mock.calls[0][1]).toEqual(expect.any(Object));
  expect(JSON.stringify(packageMocks.installSpeechPackage.mock.calls)).not.toContain(privateUrl);
});

it('rejects hostile model IDs and unknown path fields before native invocation', async () => {
  await expect(addModelFromHuggingFace({
    modelId: 'C:\\Users\\person\\private-model.bin',
  })).rejects.toMatchObject({ code: 'unsupportedModelOperation' });
  await expect(addModelFromHuggingFace({
    modelId: 'f5tts-v1-base',
    privatePath: 'C:\\Users\\person\\private-model.bin',
  })).rejects.toMatchObject({ code: 'invalidModelRequest' });

  expect(packageMocks.getSpeechPackagesStatus).not.toHaveBeenCalled();
  expect(packageMocks.installSpeechPackage).not.toHaveBeenCalled();
});

it('refuses arbitrary direct-download model transport', async () => {
  await expect(addModelFromUrl({
    modelId: 'f5tts-v1-base',
    modelUrl: 'https://example.invalid/model.bin',
  })).rejects.toMatchObject({ code: 'unsupportedModelOperation' });
  expect(packageMocks.installSpeechPackage).not.toHaveBeenCalled();
});
