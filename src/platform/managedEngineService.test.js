import fs from 'fs';
import path from 'path';
import {
  cancelEnginePackageJob,
  getEnginePackagesStatus,
  installEnginePackage,
  removeEnginePackage,
  startEngineRuntime,
  stopEngineRuntime,
} from './enginePackageService';
import {
  cancelSpeechPackageJob,
  getSpeechPackagesStatus,
  installSpeechPackage,
  removeSpeechPackage,
} from './speechPackageService';
import { probeSpeechBackend, stopSpeechRuntime } from './speechService';
import {
  ManagedEngineServiceError,
  cancelManagedEnginePackageJob,
  getManagedEngineBinding,
  getManagedEnginePackageStatus,
  installManagedEnginePackage,
  removeManagedEnginePackage,
  startManagedEngineRuntime,
  stopManagedEngineRuntime,
} from './managedEngineService';

vi.mock('./enginePackageService', () => ({
  ENGINE_PACKAGE_ENGINE_IDS: Object.freeze([
    'parakeet',
    'faster-whisper-turbo',
    'faster-whisper-large-v3',
    'qwen3-asr-1.7b',
    'qwen3-asr-0.6b',
  ]),
  cancelEnginePackageJob: vi.fn(),
  getEnginePackagesStatus: vi.fn(),
  installEnginePackage: vi.fn(),
  removeEnginePackage: vi.fn(),
  startEngineRuntime: vi.fn(),
  stopEngineRuntime: vi.fn(),
}));

vi.mock('./speechPackageService', () => ({
  cancelSpeechPackageJob: vi.fn(),
  getSpeechPackagesStatus: vi.fn(),
  installSpeechPackage: vi.fn(),
  removeSpeechPackage: vi.fn(),
}));

vi.mock('./speechService', () => ({
  probeSpeechBackend: vi.fn(),
  stopSpeechRuntime: vi.fn(),
}));

beforeEach(() => {
  getEnginePackagesStatus.mockResolvedValue({
    engines: [{ id: 'parakeet', operation: null }],
  });
  getSpeechPackagesStatus.mockResolvedValue({
    packages: [
      { id: 'f5-tts', operation: null },
      { id: 'chatterbox', operation: null },
    ],
  });
  installEnginePackage.mockResolvedValue({ id: 'asr-job' });
  removeEnginePackage.mockResolvedValue({ id: 'asr-remove-job' });
  cancelEnginePackageJob.mockResolvedValue(undefined);
  startEngineRuntime.mockResolvedValue(undefined);
  stopEngineRuntime.mockResolvedValue(undefined);
  installSpeechPackage.mockResolvedValue({ id: 'speech-job' });
  removeSpeechPackage.mockResolvedValue({ id: 'speech-remove-job' });
  cancelSpeechPackageJob.mockResolvedValue(undefined);
  probeSpeechBackend.mockResolvedValue({ status: { ready: true }, voices: [] });
  stopSpeechRuntime.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  delete global.fetch;
});

it('contains no browser transport or legacy endpoint dependency', () => {
  const source = fs.readFileSync(path.join(__dirname, 'managedEngineService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/u);
  expect(source).not.toMatch(/https?:\/\//iu);
  expect(source).not.toMatch(/API_BASE_URL|SERVER_URL/u);
});

it('canonicalizes the Parakeet alias and defines distinct F5 package/runtime identifiers', () => {
  expect(getManagedEngineBinding('nvidia-parakeet')).toEqual({
    family: 'asr',
    engineId: 'parakeet',
    packageBackend: 'parakeet',
    runtimeBackend: 'parakeet',
  });
  expect(getManagedEngineBinding('f5tts')).toEqual({
    family: 'speech',
    engineId: 'f5tts',
    label: 'F5-TTS',
    packageBackend: 'f5-tts',
    runtimeBackend: 'f5Tts',
  });
});

it('routes package status, install, removal, and cancellation by engine family', async () => {
  const handlers = { onCompleted: vi.fn() };
  const options = { signal: new AbortController().signal };

  await expect(getManagedEnginePackageStatus('parakeet'))
    .resolves.toMatchObject({ id: 'parakeet' });
  await expect(getManagedEnginePackageStatus('f5tts'))
    .resolves.toMatchObject({ id: 'f5-tts' });
  await installManagedEnginePackage('parakeet', handlers, options);
  await installManagedEnginePackage('f5tts', handlers, options);
  await removeManagedEnginePackage('qwen3-asr-0.6b', handlers, options);
  await removeManagedEnginePackage('chatterbox', handlers, options);
  await cancelManagedEnginePackageJob('parakeet', 'asr-job');
  await cancelManagedEnginePackageJob('chatterbox', 'speech-job');

  expect(getEnginePackagesStatus).toHaveBeenCalledTimes(1);
  expect(getSpeechPackagesStatus).toHaveBeenCalledTimes(1);
  expect(installEnginePackage).toHaveBeenCalledWith('parakeet', handlers, options);
  expect(installSpeechPackage).toHaveBeenCalledWith('f5-tts', handlers, options);
  expect(removeEnginePackage).toHaveBeenCalledWith('qwen3-asr-0.6b', handlers, options);
  expect(removeSpeechPackage).toHaveBeenCalledWith('chatterbox', handlers, options);
  expect(cancelEnginePackageJob).toHaveBeenCalledWith('asr-job');
  expect(cancelSpeechPackageJob).toHaveBeenCalledWith('speech-job');
});

it('routes ASR runtime controls natively and uses speech probe/shutdown for speech runtimes', async () => {
  await startManagedEngineRuntime('parakeet');
  await stopManagedEngineRuntime('parakeet');
  await startManagedEngineRuntime('f5tts');
  await stopManagedEngineRuntime('f5tts');
  await startManagedEngineRuntime('chatterbox');
  await stopManagedEngineRuntime('chatterbox');

  expect(startEngineRuntime).toHaveBeenCalledWith('parakeet');
  expect(stopEngineRuntime).toHaveBeenCalledWith('parakeet');
  expect(probeSpeechBackend).toHaveBeenNthCalledWith(1, 'f5Tts');
  expect(stopSpeechRuntime).toHaveBeenNthCalledWith(1, 'f5Tts');
  expect(probeSpeechBackend).toHaveBeenNthCalledWith(2, 'chatterbox');
  expect(stopSpeechRuntime).toHaveBeenNthCalledWith(2, 'chatterbox');
});

it('fails closed for unsupported IDs and incomplete native status without invoking another family', async () => {
  expect(() => getManagedEngineBinding('edge-tts')).toThrow(ManagedEngineServiceError);
  expect(() => installManagedEnginePackage({ id: 'parakeet' })).toThrow(ManagedEngineServiceError);
  getSpeechPackagesStatus.mockResolvedValueOnce({ packages: [] });
  await expect(getManagedEnginePackageStatus('f5tts'))
    .rejects.toMatchObject({ code: 'invalidManagedEngineStatus' });

  expect(installEnginePackage).not.toHaveBeenCalled();
  expect(installSpeechPackage).not.toHaveBeenCalled();
  expect(getEnginePackagesStatus).not.toHaveBeenCalled();
});
