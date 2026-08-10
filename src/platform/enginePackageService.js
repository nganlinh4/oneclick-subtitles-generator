import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const ENGINE_PACKAGE_ENGINE_IDS = Object.freeze([
  'parakeet',
  'faster-whisper-turbo',
  'faster-whisper-large-v3',
  'qwen3-asr-1.7b',
  'qwen3-asr-0.6b',
]);

export const ENGINE_PACKAGE_STATES = Object.freeze([
  'unavailable',
  'missing',
  'installed',
  'update-available',
  'corrupt',
]);

export const ENGINE_PACKAGE_ACTIONS = Object.freeze(['install', 'update', 'remove']);
export const ENGINE_PACKAGE_PHASES = Object.freeze([
  'queued',
  'preparing',
  'downloading',
  'verifying',
  'extracting',
  'publishing',
  'removing',
]);

const MAX_LABEL_CHARACTERS = 256;
const MAX_VERSION_CHARACTERS = 128;
const MAX_ERROR_MESSAGE_CHARACTERS = 4_096;
const MAX_PENDING_EVENTS = 4_096;
const MAX_JOB_EVENTS = 250_000;
const engineIds = new Set(ENGINE_PACKAGE_ENGINE_IDS);
const packageStates = new Set(ENGINE_PACKAGE_STATES);
const actions = new Set(ENGINE_PACKAGE_ACTIONS);
const phases = new Set(ENGINE_PACKAGE_PHASES);
const jobStates = new Set([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
const statusKeys = new Set(['schemaVersion', 'engines']);
const engineKeys = new Set([
  'id',
  'label',
  'deliveryAvailable',
  'installed',
  'updateAvailable',
  'state',
  'version',
  'availableVersion',
  'installedBytes',
  'operation',
]);
const operationKeys = new Set([
  'job',
  'engine',
  'action',
  'phase',
  'basisPoints',
  'bytesDone',
  'totalBytes',
]);
const jobKeys = new Set(['id', 'kind', 'state', 'progress', 'sequence']);
const progressKeys = new Set(['basisPoints']);
const progressEventKeys = new Set(['event', 'operation']);
const terminalEventKeys = new Set(['event', 'job', 'engine', 'action']);
const failedEventKeys = new Set(['event', 'job', 'engine', 'action', 'error']);
const errorKeys = new Set(['code', 'message']);
const handlerKeys = new Set([
  'onEvent',
  'onProgress',
  'onCompleted',
  'onCancelled',
  'onFailed',
  'onProtocolError',
  'onHandlerError',
  'onCancellationError',
]);
const optionKeys = new Set(['signal']);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainDataRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

const hasExactKeys = (value, expected) => {
  if (!isPlainDataRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

const characterCountWithin = (value, maximum) => {
  let count = 0;
  for (const unused of value) {
    void unused;
    count += 1;
    if (count > maximum) return false;
  }
  return true;
};

const containsControl = (value) => {
  for (const character of value) {
    if (character < ' ' || character === '\u007f') return true;
  }
  return false;
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export class EnginePackageServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnginePackageServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new EnginePackageServiceError(
  'invalidEnginePackageRequest',
  'The native engine package request is invalid'
);

const invalidResponse = () => new EnginePackageServiceError(
  'invalidEnginePackageResponse',
  'The desktop host returned invalid engine package data'
);

const desktopRequired = () => new EnginePackageServiceError(
  'desktopEnginePackagesRequired',
  'Engine package management requires the desktop runtime'
);

const cancelledRequest = () => new EnginePackageServiceError(
  'enginePackageCancelled',
  'The native engine package operation was cancelled'
);

const requireEngine = (engine) => {
  const canonical = engine === 'nvidia-parakeet' ? 'parakeet' : engine;
  if (!engineIds.has(canonical)) throw invalidRequest();
  return canonical;
};

const requireSafeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidResponse();
  }
  return value;
};

const normalizeVersion = (value) => {
  if (value === null) return null;
  if (typeof value !== 'string'
      || value.length === 0
      || !characterCountWithin(value, MAX_VERSION_CHARACTERS)
      || containsControl(value)) {
    throw invalidResponse();
  }
  return value;
};

export const normalizeEnginePackageJob = (snapshot) => {
  if (!hasExactKeys(snapshot, jobKeys)
      || !hasExactKeys(snapshot.progress, progressKeys)
      || !isUuidV7(snapshot.id)
      || snapshot.kind !== 'installEngine'
      || !jobStates.has(snapshot.state)) {
    throw invalidResponse();
  }
  const basisPoints = requireSafeInteger(snapshot.progress.basisPoints, 0, 10_000);
  const sequence = requireSafeInteger(snapshot.sequence);
  const invariantHolds = snapshot.state === 'queued'
    ? basisPoints === 0 && sequence === 0
    : snapshot.state === 'succeeded'
      ? basisPoints === 10_000 && sequence >= 2
      : sequence >= 1;
  if (!invariantHolds) throw invalidResponse();

  return Object.freeze({
    id: snapshot.id,
    kind: 'installEngine',
    state: snapshot.state,
    progress: Object.freeze({ basisPoints }),
    sequence,
  });
};

const normalizeOperation = (value, expectedEngine) => {
  if (!hasExactKeys(value, operationKeys)) throw invalidResponse();
  const job = normalizeEnginePackageJob(value.job);
  const engine = requireEngine(value.engine);
  if (expectedEngine !== undefined && engine !== expectedEngine) throw invalidResponse();
  if (!actions.has(value.action) || !phases.has(value.phase)) throw invalidResponse();
  if (value.action === 'remove' ? value.phase !== 'queued' && value.phase !== 'removing'
    : value.phase === 'removing') {
    throw invalidResponse();
  }
  if (!['queued', 'running', 'cancelling'].includes(job.state)) throw invalidResponse();
  const basisPoints = requireSafeInteger(value.basisPoints, 0, 10_000);
  const bytesDone = requireSafeInteger(value.bytesDone);
  const totalBytes = requireSafeInteger(value.totalBytes);
  if (basisPoints !== job.progress.basisPoints
      || bytesDone > totalBytes
      || (totalBytes === 0 && bytesDone !== 0)) {
    throw invalidResponse();
  }

  return Object.freeze({
    job,
    engine,
    action: value.action,
    phase: value.phase,
    basisPoints,
    bytesDone,
    totalBytes,
  });
};

const normalizeCommandError = (error) => {
  if (!hasExactKeys(error, errorKeys)
      || typeof error.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
      || typeof error.message !== 'string'
      || !characterCountWithin(error.message, MAX_ERROR_MESSAGE_CHARACTERS)
      || containsControl(error.message)) {
    throw invalidResponse();
  }
  return Object.freeze({ code: error.code, message: error.message });
};

export const normalizeEnginePackagesStatus = (value) => {
  if (!hasExactKeys(value, statusKeys)
      || value.schemaVersion !== 1
      || !Array.isArray(value.engines)
      || value.engines.length !== ENGINE_PACKAGE_ENGINE_IDS.length) {
    throw invalidResponse();
  }

  const byId = new Map();
  value.engines.forEach((entry) => {
    if (!hasExactKeys(entry, engineKeys)
        || !engineIds.has(entry.id)
        || byId.has(entry.id)
        || typeof entry.label !== 'string'
        || entry.label.trim().length === 0
        || !characterCountWithin(entry.label, MAX_LABEL_CHARACTERS)
        || containsControl(entry.label)
        || typeof entry.deliveryAvailable !== 'boolean'
        || typeof entry.installed !== 'boolean'
        || typeof entry.updateAvailable !== 'boolean'
        || !packageStates.has(entry.state)) {
      throw invalidResponse();
    }
    const version = normalizeVersion(entry.version);
    const availableVersion = normalizeVersion(entry.availableVersion);
    const installedBytes = requireSafeInteger(entry.installedBytes);
    const stateInvariantHolds = entry.state === 'unavailable'
      ? !entry.deliveryAvailable && !entry.updateAvailable
      : entry.state === 'missing'
        ? entry.deliveryAvailable && !entry.installed && !entry.updateAvailable
        : entry.state === 'installed'
          ? entry.installed && !entry.updateAvailable
          : entry.state === 'update-available'
            ? entry.deliveryAvailable && entry.installed && entry.updateAvailable
            : !entry.updateAvailable;
    if (!stateInvariantHolds
        || (!entry.installed && (version !== null || installedBytes !== 0))
        || (entry.updateAvailable && availableVersion === null)) {
      throw invalidResponse();
    }
    const operation = entry.operation === null
      ? null
      : normalizeOperation(entry.operation, entry.id);
    byId.set(entry.id, Object.freeze({
      id: entry.id,
      label: entry.label,
      deliveryAvailable: entry.deliveryAvailable,
      installed: entry.installed,
      updateAvailable: entry.updateAvailable,
      state: entry.state,
      version,
      availableVersion,
      installedBytes,
      operation,
    }));
  });

  return Object.freeze({
    schemaVersion: 1,
    engines: Object.freeze(ENGINE_PACKAGE_ENGINE_IDS.map((id) => byId.get(id))),
  });
};

export const normalizeEnginePackageEvent = (value) => {
  if (!isPlainDataRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  if (value.event === 'progress') {
    if (!hasExactKeys(value, progressEventKeys)) throw invalidResponse();
    return Object.freeze({ event: 'progress', operation: normalizeOperation(value.operation) });
  }
  if (value.event === 'completed' || value.event === 'cancelled') {
    if (!hasExactKeys(value, terminalEventKeys)) throw invalidResponse();
    const job = normalizeEnginePackageJob(value.job);
    const expectedState = value.event === 'completed' ? 'succeeded' : 'cancelled';
    if (job.state !== expectedState || !actions.has(value.action)) throw invalidResponse();
    return Object.freeze({
      event: value.event,
      job,
      engine: requireEngine(value.engine),
      action: value.action,
    });
  }
  if (value.event === 'failed') {
    if (!hasExactKeys(value, failedEventKeys) || !actions.has(value.action)) {
      throw invalidResponse();
    }
    const job = value.job === null ? null : normalizeEnginePackageJob(value.job);
    if (job !== null && ['queued', 'succeeded', 'cancelled'].includes(job.state)) {
      throw invalidResponse();
    }
    return Object.freeze({
      event: 'failed',
      job,
      engine: requireEngine(value.engine),
      action: value.action,
      error: normalizeCommandError(value.error),
    });
  }
  throw invalidResponse();
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!isPlainDataRecord(handlers)
      || Object.keys(handlers).some((key) => !handlerKeys.has(key))
      || Object.values(handlers).some((handler) => typeof handler !== 'function')) {
    throw invalidRequest();
  }
  return handlers;
};

const normalizeOptions = (options) => {
  if (options === undefined) return Object.freeze({});
  if (!isPlainDataRecord(options)
      || Object.keys(options).some((key) => !optionKeys.has(key))) {
    throw invalidRequest();
  }
  const { signal } = options;
  if (signal !== undefined
      && (!isRecord(signal)
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) {
    throw invalidRequest();
  }
  return options;
};

const requireDesktop = (isNativeRuntime) => {
  if (!isNativeRuntime()) throw desktopRequired();
};

export const createNativeEnginePackageService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const cancelEnginePackageJob = async (id) => {
    requireDesktop(isNativeRuntime);
    if (!isUuidV7(id)) throw invalidRequest();
    const snapshot = normalizeEnginePackageJob(await invokeCommand('job_cancel', { id }));
    if (snapshot.id !== id) throw invalidResponse();
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state)) {
      activeChannels.delete(id);
    }
    return snapshot;
  };

  const getEnginePackagesStatus = async () => {
    requireDesktop(isNativeRuntime);
    return normalizeEnginePackagesStatus(await invokeCommand('engine_packages_status', {}));
  };

  const startOperation = async (
    command,
    allowedActionInput,
    engineInput,
    handlersInput,
    optionsInput
  ) => {
    requireDesktop(isNativeRuntime);
    const engine = requireEngine(engineInput);
    const handlers = normalizeHandlers(handlersInput);
    const { signal } = normalizeOptions(optionsInput);
    if (signal?.aborted) throw cancelledRequest();

    let initial = null;
    let terminal = false;
    let protocolError = null;
    let cancellationIssued = false;
    let abortRequested = false;
    let abortListenerAttached = false;
    let eventCount = 0;
    let lastSequence = -1;
    let lastBasisPoints = -1;
    let observedAction = null;
    const pendingEvents = [];
    const allowedActions = new Set(Array.isArray(allowedActionInput)
      ? allowedActionInput
      : [allowedActionInput]);

    const safelyCall = (handler, value) => {
      if (!handler) return;
      try {
        const result = handler(value);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch((error) => {
            try { handlers.onHandlerError?.(error); } catch { /* isolated */ }
          });
        }
      } catch (error) {
        try { handlers.onHandlerError?.(error); } catch { /* isolated */ }
      }
    };

    const removeAbortListener = () => {
      if (!abortListenerAttached) return;
      signal.removeEventListener('abort', onAbort);
      abortListenerAttached = false;
    };

    const release = () => {
      removeAbortListener();
      if (initial !== null) activeChannels.delete(initial.id);
    };

    const issueCancellation = () => {
      abortRequested = true;
      if (initial === null || cancellationIssued || terminal) return;
      cancellationIssued = true;
      Promise.resolve(cancelEnginePackageJob(initial.id)).catch((error) => {
        safelyCall(handlers.onCancellationError, error);
      });
    };

    const onAbort = () => issueCancellation();

    const protocolFailure = (error = invalidResponse()) => {
      if (protocolError !== null || terminal) return;
      protocolError = error instanceof EnginePackageServiceError ? error : invalidResponse();
      safelyCall(handlers.onProtocolError, protocolError);
      issueCancellation();
      if (initial !== null) release();
    };

    const dispatch = (event) => {
      if (terminal || protocolError !== null) return;
      eventCount += 1;
      if (eventCount > MAX_JOB_EVENTS) {
        protocolFailure();
        return;
      }

      const eventJob = event.event === 'progress' ? event.operation.job : event.job;
      if (event.engine !== undefined && event.engine !== engine) {
        protocolFailure();
        return;
      }
      const eventAction = event.event === 'progress' ? event.operation.action : event.action;
      if (!allowedActions.has(eventAction)
          || (observedAction !== null && eventAction !== observedAction)) {
        protocolFailure();
        return;
      }
      observedAction = eventAction;
      if (event.event === 'progress') {
        if (event.operation.engine !== engine
            || event.operation.job.id !== initial.id
            || eventJob.sequence <= lastSequence
            || event.operation.basisPoints < lastBasisPoints) {
          protocolFailure();
          return;
        }
        lastSequence = eventJob.sequence;
        lastBasisPoints = event.operation.basisPoints;
      } else if (eventJob !== null) {
        if (eventJob.id !== initial.id || eventJob.sequence <= lastSequence) {
          protocolFailure();
          return;
        }
        lastSequence = eventJob.sequence;
        lastBasisPoints = eventJob.progress.basisPoints;
      }

      if (event.event === 'completed'
          || event.event === 'cancelled'
          || event.event === 'failed') {
        terminal = true;
        release();
      }

      safelyCall(handlers.onEvent, event);
      if (event.event === 'progress') safelyCall(handlers.onProgress, event);
      if (event.event === 'completed') safelyCall(handlers.onCompleted, event);
      if (event.event === 'cancelled') safelyCall(handlers.onCancelled, event);
      if (event.event === 'failed') safelyCall(handlers.onFailed, event);
    };

    const channel = new ChannelConstructor();
    if (signal) {
      try {
        signal.addEventListener('abort', onAbort, { once: true });
        abortListenerAttached = true;
      } catch {
        throw invalidRequest();
      }
    }
    channel.onmessage = (rawEvent) => {
      if (terminal || protocolError !== null) return;
      let event;
      try {
        event = normalizeEnginePackageEvent(rawEvent);
      } catch (error) {
        protocolFailure(error);
        return;
      }
      if (initial === null) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          protocolFailure();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      dispatch(event);
    };

    let snapshot;
    try {
      snapshot = normalizeEnginePackageJob(await invokeCommand(command, { engine, onEvent: channel }));
      initial = snapshot;
      if (!['queued', 'running'].includes(snapshot.state)) {
        protocolFailure();
        throw protocolError;
      }
      lastSequence = snapshot.sequence;
      lastBasisPoints = snapshot.progress.basisPoints;
    } catch (error) {
      pendingEvents.length = 0;
      removeAbortListener();
      throw error;
    }

    if (protocolError !== null) {
      issueCancellation();
      release();
      throw protocolError;
    }
    activeChannels.set(snapshot.id, channel);
    for (const event of pendingEvents.splice(0)) {
      dispatch(event);
      if (protocolError !== null) break;
    }
    if (protocolError !== null) {
      issueCancellation();
      release();
      throw protocolError;
    }
    if (terminal) release();
    else if (abortRequested || signal?.aborted) issueCancellation();
    return snapshot;
  };

  const installEnginePackage = (engine, handlers, options) => startOperation(
    'engine_package_install',
    ['install', 'update'],
    engine,
    handlers,
    options
  );
  const removeEnginePackage = (engine, handlers, options) => startOperation(
    'engine_package_remove',
    'remove',
    engine,
    handlers,
    options
  );
  const startEngineRuntime = async (engineInput) => {
    requireDesktop(isNativeRuntime);
    await invokeCommand('engine_runtime_start', { engine: requireEngine(engineInput) });
  };
  const stopEngineRuntime = async (engineInput) => {
    requireDesktop(isNativeRuntime);
    await invokeCommand('engine_runtime_stop', { engine: requireEngine(engineInput) });
  };

  return Object.freeze({
    getEnginePackagesStatus,
    installEnginePackage,
    removeEnginePackage,
    cancelEnginePackageJob,
    startEngineRuntime,
    stopEngineRuntime,
  });
};

const enginePackageService = createNativeEnginePackageService();

export const getEnginePackagesStatus = enginePackageService.getEnginePackagesStatus;
export const installEnginePackage = enginePackageService.installEnginePackage;
export const removeEnginePackage = enginePackageService.removeEnginePackage;
export const cancelEnginePackageJob = enginePackageService.cancelEnginePackageJob;
export const startEngineRuntime = enginePackageService.startEngineRuntime;
export const stopEngineRuntime = enginePackageService.stopEngineRuntime;
