import {
  cancelSpeechPackageJob,
  getSpeechPackagesStatus,
  installSpeechPackage,
  removeSpeechPackage,
} from '../platform/speechPackageService';

const PACKAGE_BACKEND = 'f5-tts';
const DEFAULT_MODEL_ID = 'f5tts-v1-base';
const operationStates = new Map();
const modelRequestKeys = new Set([
  'modelId', 'modelUrl', 'vocabUrl', 'languageCodes', 'config',
]);

const DEFAULT_MODEL = Object.freeze({
  id: DEFAULT_MODEL_ID,
  name: 'F5-TTS v1 Base',
  repo_id: 'SWivid/F5-TTS',
  config: Object.freeze({
    dim: 1024,
    depth: 22,
    heads: 16,
    ff_mult: 2,
    text_dim: 512,
    conv_layers: 4,
  }),
  source: 'default',
  language: 'en',
  languages: Object.freeze(['en', 'zh']),
  is_symlink: false,
  original_model_file: null,
  original_vocab_file: null,
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
const unsupportedModelOperation = () => new ModelServiceError(
  'unsupportedModelOperation',
  'Only signed desktop speech packages can be managed',
);
const modelPackageUnavailable = () => new ModelServiceError(
  'modelPackageUnavailable',
  'The managed F5-TTS package is unavailable',
);

const isPlainDataRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(value))
      .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

const requireDefaultModel = (modelId) => {
  if (modelId !== DEFAULT_MODEL_ID) throw unsupportedModelOperation();
  return modelId;
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

const progressState = (operation) => Object.freeze({
  status: operation.action === 'remove' ? 'removing' : 'downloading',
  progress: operation.basisPoints / 100,
  error: null,
  jobId: operation.job.id,
});

const terminalState = (status, jobId = null) => Object.freeze({
  status,
  progress: status === 'completed' ? 100 : 0,
  error: status === 'failed' ? 'The native speech package operation failed' : null,
  jobId,
});

const packageHandlers = Object.freeze({
  onProgress: ({ operation }) => {
    operationStates.set(DEFAULT_MODEL_ID, progressState(operation));
  },
  onCompleted: ({ job }) => {
    operationStates.set(DEFAULT_MODEL_ID, terminalState('completed', job.id));
  },
  onCancelled: ({ job }) => {
    operationStates.set(DEFAULT_MODEL_ID, terminalState('cancelled', job.id));
  },
  onFailed: ({ job }) => {
    operationStates.set(DEFAULT_MODEL_ID, terminalState('failed', job?.id ?? null));
  },
  onProtocolError: () => {
    operationStates.set(DEFAULT_MODEL_ID, terminalState('failed'));
  },
});

const rememberInitialJob = (job, action) => {
  const current = operationStates.get(DEFAULT_MODEL_ID);
  if (!current || current.jobId !== job.id
      || !['completed', 'cancelled', 'failed'].includes(current.status)) {
    operationStates.set(DEFAULT_MODEL_ID, Object.freeze({
      status: action === 'remove' ? 'removing' : 'downloading',
      progress: job.progress.basisPoints / 100,
      error: null,
      jobId: job.id,
    }));
  }
};

export const getModelServiceStatus = async () => {
  const entry = await getF5Package();
  return Object.freeze({
    available: entry.deliveryAvailable,
    installed: entry.installed,
    state: entry.state,
    operation: entry.operation,
  });
};

export const getModels = async () => {
  const entry = await getF5Package();
  return Object.freeze({
    models: Object.freeze(entry.installed ? [modelFromPackage(entry)] : []),
    active_model: entry.installed ? DEFAULT_MODEL_ID : null,
    package_state: entry.state,
  });
};

export const getActiveModel = async () => {
  const entry = await getF5Package();
  return Object.freeze({ active_model: entry.installed ? DEFAULT_MODEL_ID : null });
};

export const setActiveModel = async (modelId) => {
  requireDefaultModel(modelId);
  const entry = await getF5Package();
  if (!entry.installed) throw modelPackageUnavailable();
  return Object.freeze({ success: true, active_model: DEFAULT_MODEL_ID });
};

export const addModelFromHuggingFace = async (modelData) => {
  if (!isPlainDataRecord(modelData)
      || Object.keys(modelData).some((key) => !modelRequestKeys.has(key))) {
    throw invalidModelRequest();
  }
  requireDefaultModel(modelData.modelId);
  const entry = await getF5Package();
  if (!entry.deliveryAvailable) throw modelPackageUnavailable();
  if (entry.operation) {
    if (!['install', 'update'].includes(entry.operation.action)) {
      throw modelPackageUnavailable();
    }
    operationStates.set(DEFAULT_MODEL_ID, progressState(entry.operation));
    return Object.freeze({
      success: true,
      model_id: DEFAULT_MODEL_ID,
      job_id: entry.operation.job.id,
    });
  }
  if (entry.installed && !entry.updateAvailable) {
    return Object.freeze({ success: true, model_id: DEFAULT_MODEL_ID });
  }
  const job = await installSpeechPackage(PACKAGE_BACKEND, packageHandlers);
  rememberInitialJob(job, 'install');
  return Object.freeze({ success: true, model_id: DEFAULT_MODEL_ID, job_id: job.id });
};

export const addModelFromUrl = async () => {
  throw unsupportedModelOperation();
};

export const getModelDownloadStatus = async (modelId) => {
  requireDefaultModel(modelId);
  const entry = await getF5Package();
  if (entry.operation) return progressState(entry.operation);
  const tracked = operationStates.get(DEFAULT_MODEL_ID);
  if (tracked) return tracked;
  if (entry.installed) return terminalState('completed');
  return Object.freeze({ status: null, progress: 0, error: null, jobId: null });
};

export const deleteModel = async (modelId) => {
  requireDefaultModel(modelId);
  const entry = await getF5Package();
  if (!entry.deliveryAvailable) throw modelPackageUnavailable();
  if (entry.operation) {
    if (entry.operation.action !== 'remove') throw modelPackageUnavailable();
    operationStates.set(DEFAULT_MODEL_ID, progressState(entry.operation));
    return Object.freeze({ success: true, job_id: entry.operation.job.id });
  }
  if (!entry.installed) return Object.freeze({ success: true });
  const job = await removeSpeechPackage(PACKAGE_BACKEND, packageHandlers);
  rememberInitialJob(job, 'remove');
  return Object.freeze({ success: true, job_id: job.id });
};

export const updateModelInfo = async (modelId) => {
  requireDefaultModel(modelId);
  throw unsupportedModelOperation();
};

export const getModelStorageInfo = async (modelId) => {
  requireDefaultModel(modelId);
  const entry = await getF5Package();
  return Object.freeze({
    size: entry.installedBytes,
    is_symlink: false,
    source: 'default',
  });
};

export const cancelModelDownload = async (modelId) => {
  requireDefaultModel(modelId);
  const entry = await getF5Package();
  const tracked = operationStates.get(DEFAULT_MODEL_ID);
  const jobId = entry.operation?.job.id ?? tracked?.jobId;
  const active = entry.operation !== null
    || ['downloading', 'removing'].includes(tracked?.status ?? '');
  if (!jobId || !active) {
    return Object.freeze({ success: true });
  }
  await cancelSpeechPackageJob(jobId);
  operationStates.set(DEFAULT_MODEL_ID, terminalState('cancelled', jobId));
  return Object.freeze({ success: true });
};

export const scanModelsDirectory = async () => {
  const entry = await getF5Package();
  return Object.freeze({ success: true, modelsFound: entry.installed ? 1 : 0 });
};
