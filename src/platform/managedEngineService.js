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
const preparations = new Map();
const PACKAGE_POLL_MS = 500;
const PACKAGE_WAIT_MS = 2 * 60 * 60 * 1_000;

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

const aborted = () => new ManagedEngineServiceError(
  'managedEnginePreparationCancelled',
  'Managed engine preparation was cancelled',
);
const packageUnavailable = () => new ManagedEngineServiceError(
  'managedEnginePackageUnavailable',
  'The managed engine package is unavailable',
);

const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(aborted());
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(aborted());
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, milliseconds);
  signal?.addEventListener('abort', onAbort, { once: true });
});

const waitForPackageOperation = async (engineInput, signal) => {
  const deadline = Date.now() + PACKAGE_WAIT_MS;
  while (true) {
    if (signal?.aborted) throw aborted();
    const status = await getManagedEnginePackageStatus(engineInput);
    if (!status.operation) return status;
    if (Date.now() >= deadline) {
      throw new ManagedEngineServiceError(
        'managedEnginePreparationTimedOut',
        'The managed engine package operation did not finish in time',
      );
    }
    await wait(PACKAGE_POLL_MS, signal);
  }
};

const installAndWait = async (engineInput, signal, onProgress) => {
  let resolveTerminal;
  let rejectTerminal;
  const terminal = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  await installManagedEnginePackage(engineInput, {
    onProgress: (event) => onProgress?.(event),
    onCompleted: resolveTerminal,
    onCancelled: () => rejectTerminal(aborted()),
    onFailed: (event) => rejectTerminal(new ManagedEngineServiceError(
      event?.error?.code || 'managedEngineInstallationFailed',
      'The managed engine package could not be installed',
    )),
    onProtocolError: rejectTerminal,
  }, { signal });
  await terminal;
  return waitForPackageOperation(engineInput, signal);
};

/** Prepare dependencies only in response to an explicit feature action. */
export const ensureManagedEngineReady = (engineInput, { signal, onProgress } = {}) => {
  const binding = getManagedEngineBinding(engineInput);
  const existing = preparations.get(binding.engineId);
  if (existing) return existing;
  const preparation = (async () => {
    let status = await waitForPackageOperation(binding.engineId, signal);
    if (!status.installed || status.state === 'corrupt') {
      if (!status.deliveryAvailable) throw packageUnavailable();
      status = await installAndWait(binding.engineId, signal, onProgress);
    }
    if (!status.installed || status.state === 'corrupt') throw packageUnavailable();
    if (signal?.aborted) throw aborted();
    return startManagedEngineRuntime(binding.engineId);
  })();
  preparations.set(binding.engineId, preparation);
  preparation.finally(() => {
    if (preparations.get(binding.engineId) === preparation) preparations.delete(binding.engineId);
  }).catch(() => undefined);
  return preparation;
};
