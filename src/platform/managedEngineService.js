import {
  ENGINE_PACKAGE_ENGINE_IDS,
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
import { MANAGED_SPEECH_ENGINE_BINDINGS } from './managedEngineCatalog';

const speechBindingByEngine = new Map(
  MANAGED_SPEECH_ENGINE_BINDINGS.map((binding) => [binding.engineId, binding])
);
const asrEngineIds = new Set(ENGINE_PACKAGE_ENGINE_IDS);

export class ManagedEngineServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagedEngineServiceError';
    this.code = code;
  }
}

const invalidEngine = () => new ManagedEngineServiceError(
  'invalidManagedEngine',
  'The managed engine identifier is invalid'
);
const invalidStatus = () => new ManagedEngineServiceError(
  'invalidManagedEngineStatus',
  'The native host returned incomplete managed engine status'
);

export const getManagedEngineBinding = (engineInput) => {
  const engine = engineInput === 'nvidia-parakeet' ? 'parakeet' : engineInput;
  if (typeof engine !== 'string') throw invalidEngine();
  const speech = speechBindingByEngine.get(engine);
  if (speech) return Object.freeze({ family: 'speech', ...speech });
  if (asrEngineIds.has(engine)) {
    return Object.freeze({
      family: 'asr',
      engineId: engine,
      packageBackend: engine,
      runtimeBackend: engine,
    });
  }
  throw invalidEngine();
};

export const getManagedEnginePackageStatus = async (engineInput) => {
  const binding = getManagedEngineBinding(engineInput);
  const status = binding.family === 'speech'
    ? await getSpeechPackagesStatus()
    : await getEnginePackagesStatus();
  const entries = binding.family === 'speech' ? status.packages : status.engines;
  const entry = entries.find(({ id }) => id === binding.packageBackend);
  if (!entry) throw invalidStatus();
  return entry;
};

export const installManagedEnginePackage = (engineInput, handlers, options) => {
  const binding = getManagedEngineBinding(engineInput);
  return binding.family === 'speech'
    ? installSpeechPackage(binding.packageBackend, handlers, options)
    : installEnginePackage(binding.packageBackend, handlers, options);
};

export const removeManagedEnginePackage = (engineInput, handlers, options) => {
  const binding = getManagedEngineBinding(engineInput);
  return binding.family === 'speech'
    ? removeSpeechPackage(binding.packageBackend, handlers, options)
    : removeEnginePackage(binding.packageBackend, handlers, options);
};

export const cancelManagedEnginePackageJob = (engineInput, jobId) => {
  const binding = getManagedEngineBinding(engineInput);
  return binding.family === 'speech'
    ? cancelSpeechPackageJob(jobId)
    : cancelEnginePackageJob(jobId);
};

export const startManagedEngineRuntime = (engineInput) => {
  const binding = getManagedEngineBinding(engineInput);
  return binding.family === 'speech'
    ? probeSpeechBackend(binding.runtimeBackend)
    : startEngineRuntime(binding.runtimeBackend);
};

export const stopManagedEngineRuntime = (engineInput) => {
  const binding = getManagedEngineBinding(engineInput);
  return binding.family === 'speech'
    ? stopSpeechRuntime(binding.runtimeBackend)
    : stopEngineRuntime(binding.runtimeBackend);
};
