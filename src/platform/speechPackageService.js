import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const SPEECH_PACKAGE_BACKENDS = Object.freeze([
  'f5-tts',
  'chatterbox',
  'edge-tts',
  'gtts',
  'gemini-tts',
]);

const backendSet = new Set(SPEECH_PACKAGE_BACKENDS);
const stateSet = new Set([
  'unavailable', 'missing', 'installed', 'update-available', 'corrupt',
]);
const actionSet = new Set(['install', 'update', 'remove']);
const phaseSet = new Set([
  'preparing', 'downloading', 'verifying', 'extracting', 'publishing', 'removing',
]);
const jobStateSet = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const statusKeys = new Set(['schemaVersion', 'packages']);
const packageKeys = new Set([
  'id', 'label', 'deliveryAvailable', 'installed', 'updateAvailable', 'state',
  'version', 'availableVersion', 'installedBytes', 'downloadBytes',
  'availableInstalledBytes', 'operation',
]);
const operationKeys = new Set([
  'job', 'backend', 'action', 'phase', 'basisPoints', 'bytesDone', 'totalBytes',
]);
const jobKeys = new Set(['id', 'kind', 'state', 'progress', 'sequence']);
const progressKeys = new Set(['basisPoints']);
const errorKeys = new Set(['code', 'message']);
const handlerKeys = new Set([
  'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed',
  'onProtocolError', 'onHandlerError', 'onCancellationError',
]);
const MAX_PENDING_EVENTS = 4_096;
const MAX_JOB_EVENTS = 250_000;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(value))
      .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};
const hasExactKeys = (value, keys) => isPlainRecord(value)
  && Object.keys(value).length === keys.size
  && Object.keys(value).every((key) => keys.has(key));
const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};
const safeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
);
const containsControl = (value) => {
  for (const character of value) {
    if (character < ' ' || character === '\u007f') return true;
  }
  return false;
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
const safeText = (value, maximum) => typeof value === 'string'
  && value.length > 0
  && characterCountWithin(value, maximum)
  && !containsControl(value);

export class SpeechPackageServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpeechPackageServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new SpeechPackageServiceError(
  'invalidSpeechPackageRequest',
  'The native speech package request is invalid',
);
const invalidResponse = () => new SpeechPackageServiceError(
  'invalidSpeechPackageResponse',
  'The desktop host returned invalid speech package data',
);
const desktopRequired = () => new SpeechPackageServiceError(
  'desktopSpeechPackagesRequired',
  'Speech package management requires the desktop runtime',
);
const cancelledRequest = () => new SpeechPackageServiceError(
  'speechPackageCancelled',
  'The native speech package operation was cancelled',
);
const nativeFailure = () => new SpeechPackageServiceError(
  'nativeSpeechPackageFailure',
  'The native speech package operation failed',
);

const redactNativeFailure = (error) => {
  if (error instanceof SpeechPackageServiceError) return error;
  return nativeFailure();
};

const requireBackend = (backend) => {
  if (!backendSet.has(backend)) throw invalidRequest();
  return backend;
};

const requireResponseBackend = (backend) => {
  if (!backendSet.has(backend)) throw invalidResponse();
  return backend;
};

const normalizeVersion = (value) => {
  if (value === null) return null;
  if (!safeText(value, 128)) throw invalidResponse();
  return value;
};

export const normalizeSpeechPackageJob = (value) => {
  if (!hasExactKeys(value, jobKeys)
      || !hasExactKeys(value.progress, progressKeys)
      || !isUuidV7(value.id)
      || value.kind !== 'installEngine'
      || !jobStateSet.has(value.state)
      || !safeInteger(value.progress.basisPoints, 0, 10_000)
      || !safeInteger(value.sequence)) {
    throw invalidResponse();
  }
  const basisPoints = value.progress.basisPoints;
  const validState = value.state === 'queued'
    ? basisPoints === 0 && value.sequence === 0
    : value.state === 'succeeded'
      ? basisPoints === 10_000 && value.sequence >= 2
      : value.sequence >= 1;
  if (!validState) throw invalidResponse();
  return Object.freeze({
    id: value.id,
    kind: 'installEngine',
    state: value.state,
    progress: Object.freeze({ basisPoints }),
    sequence: value.sequence,
  });
};

const normalizeOperation = (value, expectedBackend) => {
  if (!hasExactKeys(value, operationKeys)
      || !actionSet.has(value.action)
      || !phaseSet.has(value.phase)
      || !safeInteger(value.basisPoints, 0, 10_000)
      || !safeInteger(value.bytesDone)
      || !safeInteger(value.totalBytes)
      || value.bytesDone > value.totalBytes) {
    throw invalidResponse();
  }
  const backend = requireResponseBackend(value.backend);
  const job = normalizeSpeechPackageJob(value.job);
  if ((expectedBackend && backend !== expectedBackend)
      || value.basisPoints !== job.progress.basisPoints
      || !['queued', 'running', 'cancelling'].includes(job.state)
      || (value.action === 'remove'
        ? !['preparing', 'removing'].includes(value.phase)
        : value.phase === 'removing')
      || (value.totalBytes === 0 && value.bytesDone !== 0)) {
    throw invalidResponse();
  }
  return Object.freeze({
    job,
    backend,
    action: value.action,
    phase: value.phase,
    basisPoints: value.basisPoints,
    bytesDone: value.bytesDone,
    totalBytes: value.totalBytes,
  });
};

export const normalizeSpeechPackagesStatus = (value) => {
  if (!hasExactKeys(value, statusKeys)
      || value.schemaVersion !== 1
      || !Array.isArray(value.packages)
      || value.packages.length !== SPEECH_PACKAGE_BACKENDS.length) {
    throw invalidResponse();
  }
  const byId = new Map();
  value.packages.forEach((entry) => {
    if (!hasExactKeys(entry, packageKeys)
        || !safeText(entry.label, 256)
        || typeof entry.deliveryAvailable !== 'boolean'
        || typeof entry.installed !== 'boolean'
        || typeof entry.updateAvailable !== 'boolean'
        || !stateSet.has(entry.state)
        || !safeInteger(entry.installedBytes)
        || !safeInteger(entry.downloadBytes)
        || !safeInteger(entry.availableInstalledBytes)) {
      throw invalidResponse();
    }
    const id = requireResponseBackend(entry.id);
    if (byId.has(id)) throw invalidResponse();
    const version = normalizeVersion(entry.version);
    const availableVersion = normalizeVersion(entry.availableVersion);
    const operation = entry.operation === null ? null : normalizeOperation(entry.operation, id);
    const stateMatches = entry.state === 'unavailable'
      ? !entry.deliveryAvailable && !entry.installed && !entry.updateAvailable
      : entry.state === 'missing'
        ? entry.deliveryAvailable && !entry.installed && !entry.updateAvailable
        : entry.state === 'installed'
          ? entry.deliveryAvailable && entry.installed && !entry.updateAvailable
          : entry.state === 'update-available'
            ? entry.deliveryAvailable && entry.installed && entry.updateAvailable
            : entry.deliveryAvailable;
    if (!stateMatches
        || (entry.installed !== (version !== null))
        || (entry.deliveryAvailable !== (availableVersion !== null))
        || (!entry.installed && entry.installedBytes !== 0)
        || (entry.deliveryAvailable !== (
          entry.downloadBytes > 0 && entry.availableInstalledBytes > 0
        ))) {
      throw invalidResponse();
    }
    byId.set(id, Object.freeze({
      id,
      label: entry.label,
      deliveryAvailable: entry.deliveryAvailable,
      installed: entry.installed,
      updateAvailable: entry.updateAvailable,
      state: entry.state,
      version,
      availableVersion,
      installedBytes: entry.installedBytes,
      downloadBytes: entry.downloadBytes,
      availableInstalledBytes: entry.availableInstalledBytes,
      operation,
    }));
  });
  if (byId.size !== SPEECH_PACKAGE_BACKENDS.length) throw invalidResponse();
  return Object.freeze({
    schemaVersion: 1,
    packages: Object.freeze(SPEECH_PACKAGE_BACKENDS.map((id) => byId.get(id))),
  });
};

const normalizeError = (value) => {
  if (!hasExactKeys(value, errorKeys)
      || typeof value.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/u.test(value.code)
      || typeof value.message !== 'string'
      || !characterCountWithin(value.message, 4_096)
      || containsControl(value.message)) {
    throw invalidResponse();
  }
  return Object.freeze({
    code: value.code,
    message: 'The native speech package operation failed',
  });
};

export const normalizeSpeechPackageEvent = (value) => {
  if (!isPlainRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  if (value.event === 'progress') {
    if (!hasExactKeys(value, new Set(['event', 'operation']))) throw invalidResponse();
    return Object.freeze({ event: 'progress', operation: normalizeOperation(value.operation) });
  }
  if (value.event === 'completed' || value.event === 'cancelled') {
    if (!hasExactKeys(value, new Set(['event', 'job', 'backend', 'action']))) {
      throw invalidResponse();
    }
    const job = normalizeSpeechPackageJob(value.job);
    if (job.state !== (value.event === 'completed' ? 'succeeded' : 'cancelled')
        || !actionSet.has(value.action)) {
      throw invalidResponse();
    }
    return Object.freeze({
      event: value.event,
      job,
      backend: requireResponseBackend(value.backend),
      action: value.action,
    });
  }
  if (value.event === 'failed') {
    if (!hasExactKeys(value, new Set(['event', 'job', 'backend', 'action', 'error']))
        || !actionSet.has(value.action)) {
      throw invalidResponse();
    }
    const job = value.job === null ? null : normalizeSpeechPackageJob(value.job);
    if (job && ['queued', 'succeeded', 'cancelled'].includes(job.state)) {
      throw invalidResponse();
    }
    return Object.freeze({
      event: 'failed',
      job,
      backend: requireResponseBackend(value.backend),
      action: value.action,
      error: normalizeError(value.error),
    });
  }
  throw invalidResponse();
};

const normalizeHandlers = (handlers = {}) => {
  if (!isPlainRecord(handlers)
      || Object.keys(handlers).some((key) => !handlerKeys.has(key))
      || Object.values(handlers).some((handler) => typeof handler !== 'function')) {
    throw invalidRequest();
  }
  return handlers;
};

export const createNativeSpeechPackageService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();
  const requireDesktop = () => {
    if (!isNativeRuntime()) throw desktopRequired();
  };

  const cancelSpeechPackageJob = async (id) => {
    requireDesktop();
    if (!isUuidV7(id)) throw invalidRequest();
    let raw;
    try {
      raw = await invokeCommand('job_cancel', { id });
    } catch (error) {
      throw redactNativeFailure(error);
    }
    const job = normalizeSpeechPackageJob(raw);
    if (job.id !== id) throw invalidResponse();
    if (!['queued', 'running', 'cancelling'].includes(job.state)) activeChannels.delete(id);
    return job;
  };

  const getSpeechPackagesStatus = async () => {
    requireDesktop();
    let raw;
    try {
      raw = await invokeCommand('speech_packages_status', {});
    } catch (error) {
      throw redactNativeFailure(error);
    }
    return normalizeSpeechPackagesStatus(raw);
  };

  const start = async (command, expectedActions, backendInput, handlersInput, options = {}) => {
    requireDesktop();
    const backend = requireBackend(backendInput);
    const handlers = normalizeHandlers(handlersInput);
    if (!isPlainRecord(options)
        || Object.keys(options).some((key) => key !== 'signal')) throw invalidRequest();
    const { signal } = options;
    if (signal !== undefined
        && (!isRecord(signal)
          || typeof signal.aborted !== 'boolean'
          || typeof signal.addEventListener !== 'function'
          || typeof signal.removeEventListener !== 'function')) throw invalidRequest();
    if (signal?.aborted) throw cancelledRequest();

    const allowedActions = new Set(expectedActions);
    const pending = [];
    let initial = null;
    let terminal = false;
    let protocolFailed = false;
    let cancellationIssued = false;
    let lastSequence = -1;
    let lastProgress = -1;
    let observedAction = null;
    let eventCount = 0;

    const call = (handler, event) => {
      if (!handler) return;
      try {
        const result = handler(event);
        if (result?.then) Promise.resolve(result).catch(handlers.onHandlerError || (() => undefined));
      } catch (error) {
        try { handlers.onHandlerError?.(error); } catch { /* isolated */ }
      }
    };
    const cancel = () => {
      if (!initial || terminal || cancellationIssued) return;
      cancellationIssued = true;
      cancelSpeechPackageJob(initial.id).catch((error) => call(
        handlers.onCancellationError,
        error,
      ));
    };
    const release = () => {
      if (initial) activeChannels.delete(initial.id);
      signal?.removeEventListener('abort', cancel);
    };
    const protocolFailure = () => {
      if (protocolFailed || terminal) return;
      protocolFailed = true;
      call(handlers.onProtocolError, invalidResponse());
      cancel();
      release();
    };
    const dispatch = (event) => {
      if (terminal || protocolFailed) return;
      eventCount += 1;
      const eventJob = event.event === 'progress' ? event.operation.job : event.job;
      const eventBackend = event.event === 'progress' ? event.operation.backend : event.backend;
      const action = event.event === 'progress' ? event.operation.action : event.action;
      if (eventCount > MAX_JOB_EVENTS
          || eventBackend !== backend
          || !allowedActions.has(action)
          || (observedAction && observedAction !== action)
          || (eventJob && (eventJob.id !== initial.id || eventJob.sequence <= lastSequence))) {
        protocolFailure();
        return;
      }
      observedAction = action;
      if (eventJob) {
        if (eventJob.progress.basisPoints < lastProgress) {
          protocolFailure();
          return;
        }
        lastSequence = eventJob.sequence;
        lastProgress = eventJob.progress.basisPoints;
      }
      if (event.event !== 'progress') {
        terminal = true;
        release();
      }
      call(handlers.onEvent, event);
      if (event.event === 'progress') call(handlers.onProgress, event);
      if (event.event === 'completed') call(handlers.onCompleted, event);
      if (event.event === 'cancelled') call(handlers.onCancelled, event);
      if (event.event === 'failed') call(handlers.onFailed, event);
    };

    const channel = new ChannelConstructor();
    channel.onmessage = (raw) => {
      let event;
      try {
        event = normalizeSpeechPackageEvent(raw);
      } catch {
        protocolFailure();
        return;
      }
      if (!initial) {
        if (pending.length >= MAX_PENDING_EVENTS) protocolFailure();
        else pending.push(event);
        return;
      }
      dispatch(event);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      let raw;
      try {
        raw = await invokeCommand(command, { backend, onEvent: channel });
      } catch (error) {
        throw redactNativeFailure(error);
      }
      initial = normalizeSpeechPackageJob(raw);
      if (!['queued', 'running'].includes(initial.state)) throw invalidResponse();
      lastSequence = initial.sequence;
      lastProgress = initial.progress.basisPoints;
    } catch (error) {
      pending.length = 0;
      signal?.removeEventListener('abort', cancel);
      throw error;
    }
    if (protocolFailed) {
      cancel();
      release();
      throw invalidResponse();
    }
    activeChannels.set(initial.id, channel);
    pending.splice(0).forEach(dispatch);
    if (protocolFailed) throw invalidResponse();
    if (terminal) release();
    else if (signal?.aborted) cancel();
    return initial;
  };

  return Object.freeze({
    getSpeechPackagesStatus,
    installSpeechPackage: (backend, handlers, options) => start(
      'speech_package_install', ['install', 'update'], backend, handlers, options,
    ),
    removeSpeechPackage: (backend, handlers, options) => start(
      'speech_package_remove', ['remove'], backend, handlers, options,
    ),
    cancelSpeechPackageJob,
  });
};

const speechPackageService = createNativeSpeechPackageService();

export const getSpeechPackagesStatus = speechPackageService.getSpeechPackagesStatus;
export const installSpeechPackage = speechPackageService.installSpeechPackage;
export const removeSpeechPackage = speechPackageService.removeSpeechPackage;
export const cancelSpeechPackageJob = speechPackageService.cancelSpeechPackageJob;
