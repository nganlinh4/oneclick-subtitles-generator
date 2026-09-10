import {
  cancelSpeechPackageJob,
  getSpeechPackagesStatus,
  installSpeechPackage,
  removeSpeechPackage,
} from '../platform/speechPackageService';
import { getF5ModelsStatus } from '../platform/f5ModelService';

const PACKAGE_BACKEND = 'f5-tts';
export const DEFAULT_NARRATION_MODEL_ID = 'f5tts-v1-base';

const handlerKeys = new Set([
  'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed',
  'onProtocolError', 'onHandlerError', 'onCancellationError',
]);

const DEFAULT_MODEL = Object.freeze({
  id: DEFAULT_NARRATION_MODEL_ID,
  name: 'F5-TTS v1 Base',
  repo_id: 'SWivid/F5-TTS',
  source: 'signed-package',
  language: 'en',
  languages: Object.freeze(['en', 'zh']),
  config: Object.freeze({
    dim: 1024,
    depth: 22,
    heads: 16,
    ff_mult: 2,
    text_dim: 512,
    conv_layers: 4,
  }),
});

export class ModelServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelServiceError';
    this.code = code;
  }
}

const invalidModelRequest = () => new ModelServiceError(
  'invalidModelRequest',
  'The narration model request is invalid',
);
const modelPackageUnavailable = () => new ModelServiceError(
  'modelPackageUnavailable',
  'The managed F5-TTS package is unavailable',
);
const modelPackageBusy = () => new ModelServiceError(
  'modelPackageBusy',
  'Another narration model package operation is already running',
);

const isPlainDataRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(value))
      .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

const requireHandlers = (handlers = {}) => {
  if (!isPlainDataRecord(handlers)
      || Object.keys(handlers).some((key) => !handlerKeys.has(key))
      || Object.values(handlers).some((handler) => typeof handler !== 'function')) {
    throw invalidModelRequest();
  }
  return handlers;
};

const getF5Package = async () => {
  const status = await getSpeechPackagesStatus();
  const entry = status.packages.find(({ id }) => id === PACKAGE_BACKEND);
  if (!entry) throw modelPackageUnavailable();
  return entry;
};

const modelFromPackage = (entry) => Object.freeze({
  ...DEFAULT_MODEL,
  config: DEFAULT_MODEL.config,
  languages: DEFAULT_MODEL.languages,
  version: entry.version,
});

const publicPackageStatus = (entry) => Object.freeze({
  model: DEFAULT_MODEL,
  deliveryAvailable: entry.deliveryAvailable,
  installed: entry.installed,
  updateAvailable: entry.updateAvailable,
  state: entry.state,
  version: entry.version,
  availableVersion: entry.availableVersion,
  installedBytes: entry.installedBytes,
  downloadBytes: entry.downloadBytes,
  availableInstalledBytes: entry.availableInstalledBytes,
  operation: entry.operation,
});

export const getNarrationModelPackageStatus = async () => (
  publicPackageStatus(await getF5Package())
);

// The public narration-model inventory intentionally contains one entry. Arbitrary model URLs and
// filesystem paths are not part of the desktop contract; the native delivery catalog owns bytes.
export const getModels = async () => {
  const [entry, variants] = await Promise.all([
    getF5Package(), getF5ModelsStatus().catch(() => []),
  ]);
  const installedVariants = variants.filter(({ installed }) => installed).map((variant) => Object.freeze({
    id: variant.id,
    name: variant.name,
    repo_id: variant.author,
    source: 'verified-optional-model',
    language: variant.language,
    languages: variant.languages,
    license: variant.license,
    revision: variant.revision,
    config: Object.freeze({ architecture: variant.architecture }),
  }));
  return Object.freeze({
    models: Object.freeze(entry.installed ? [modelFromPackage(entry), ...installedVariants] : []),
    active_model: entry.installed ? DEFAULT_NARRATION_MODEL_ID : null,
    package_state: entry.state,
  });
};

export const installNarrationModelPackage = async (handlersInput = {}) => {
  const handlers = requireHandlers(handlersInput);
  const entry = await getF5Package();
  if (!entry.deliveryAvailable) throw modelPackageUnavailable();
  if (entry.operation) {
    if (!['install', 'update'].includes(entry.operation.action)) throw modelPackageBusy();
    return Object.freeze({ started: false, job: entry.operation.job });
  }
  if (entry.installed && !entry.updateAvailable && entry.state !== 'corrupt') {
    return Object.freeze({ started: false, job: null });
  }
  const job = await installSpeechPackage(PACKAGE_BACKEND, handlers);
  return Object.freeze({ started: true, job });
};

export const removeNarrationModelPackage = async (handlersInput = {}) => {
  const handlers = requireHandlers(handlersInput);
  const entry = await getF5Package();
  if (entry.operation) {
    if (entry.operation.action !== 'remove') throw modelPackageBusy();
    return Object.freeze({ started: false, job: entry.operation.job });
  }
  if (!entry.installed) return Object.freeze({ started: false, job: null });
  if (!entry.deliveryAvailable) throw modelPackageUnavailable();
  const job = await removeSpeechPackage(PACKAGE_BACKEND, handlers);
  return Object.freeze({ started: true, job });
};

export const cancelNarrationModelPackageOperation = async () => {
  const entry = await getF5Package();
  if (!entry.operation) return Object.freeze({ cancelled: false, job: null });
  const job = await cancelSpeechPackageJob(entry.operation.job.id);
  return Object.freeze({ cancelled: true, job });
};
