import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const PACKAGE_ID = 'remotion-runtime';
const STATES = new Set(['unavailable', 'missing', 'installed', 'update-available', 'corrupt']);
const ACTIONS = new Set(['install', 'remove']);
const PHASES = new Set([
  'preparing', 'downloading', 'verifying', 'extracting', 'publishing', 'removing',
]);
const JOB_STATES = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const STATUS_KEYS = new Set([
  'schemaVersion', 'id', 'label', 'deliveryAvailable', 'installed', 'updateAvailable',
  'state', 'version', 'availableVersion', 'installedBytes', 'downloadBytes',
  'availableInstalledBytes', 'operation',
]);
const OPERATION_KEYS = new Set([
  'job', 'package', 'action', 'phase', 'basisPoints', 'bytesDone', 'totalBytes',
]);
const JOB_KEYS = new Set(['id', 'kind', 'state', 'progress', 'sequence']);
const PROGRESS_KEYS = new Set(['basisPoints']);
const ERROR_KEYS = new Set(['code', 'message']);
const MAX_PENDING_EVENTS = 4096;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};
const hasExactKeys = (value, keys) => isPlainRecord(value)
  && Object.keys(value).length === keys.size
  && Object.keys(value).every((key) => keys.has(key));
const safeInteger = (value, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= 0 && value <= maximum
);
const safeText = (value, maximum = 4096) => typeof value === 'string'
  && value.length > 0
  && value.length <= maximum
  && !Array.from(value).some((character) => (
    (character < ' ' && character !== '\t') || character === '\u007f'
  ));
const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try { return uuidVersion(value) === 7; } catch { return false; }
};

export class RenderPackageServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RenderPackageServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new RenderPackageServiceError(
  'invalidRenderPackageRequest', 'The render package request is invalid'
);
const invalidResponse = () => new RenderPackageServiceError(
  'invalidRenderPackageResponse', 'The desktop host returned invalid render package data'
);

const normalizeVersion = (value) => {
  if (value === null) return null;
  if (!safeText(value, 128)) throw invalidResponse();
  return value;
};

export const normalizeRenderPackageJob = (value) => {
  if (!hasExactKeys(value, JOB_KEYS)
      || !hasExactKeys(value.progress, PROGRESS_KEYS)
      || !isUuidV7(value.id)
      || value.kind !== 'installEngine'
      || !JOB_STATES.has(value.state)
      || !safeInteger(value.progress.basisPoints, 10_000)
      || !safeInteger(value.sequence)) {
    throw invalidResponse();
  }
  const basisPoints = value.progress.basisPoints;
  if ((value.state === 'queued' && (basisPoints !== 0 || value.sequence !== 0))
      || (value.state === 'succeeded' && (basisPoints !== 10_000 || value.sequence < 2))
      || (!['queued', 'succeeded'].includes(value.state) && value.sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: value.id,
    kind: value.kind,
    state: value.state,
    progress: Object.freeze({ basisPoints }),
    sequence: value.sequence,
  });
};

const normalizeOperation = (value) => {
  if (!hasExactKeys(value, OPERATION_KEYS)
      || value.package !== PACKAGE_ID
      || !ACTIONS.has(value.action)
      || !PHASES.has(value.phase)
      || (value.action === 'remove' ? value.phase !== 'removing' : value.phase === 'removing')
      || !safeInteger(value.basisPoints, 10_000)
      || !safeInteger(value.bytesDone)
      || !safeInteger(value.totalBytes)
      || value.bytesDone > value.totalBytes) {
    throw invalidResponse();
  }
  const job = normalizeRenderPackageJob(value.job);
  if (!['queued', 'running', 'cancelling'].includes(job.state)
      || job.progress.basisPoints !== value.basisPoints) throw invalidResponse();
  return Object.freeze({ ...value, job });
};

export const normalizeRenderPackageStatus = (value) => {
  if (!hasExactKeys(value, STATUS_KEYS)
      || value.schemaVersion !== 1
      || value.id !== PACKAGE_ID
      || !safeText(value.label, 256)
      || typeof value.deliveryAvailable !== 'boolean'
      || typeof value.installed !== 'boolean'
      || typeof value.updateAvailable !== 'boolean'
      || !STATES.has(value.state)
      || !safeInteger(value.installedBytes)
      || !safeInteger(value.downloadBytes)
      || !safeInteger(value.availableInstalledBytes)) {
    throw invalidResponse();
  }
  const version = normalizeVersion(value.version);
  const availableVersion = normalizeVersion(value.availableVersion);
  const stateInvariant = value.state === 'unavailable'
    ? !value.deliveryAvailable && !value.updateAvailable
    : value.state === 'missing'
      ? value.deliveryAvailable && !value.installed && !value.updateAvailable
      : value.state === 'installed'
        ? value.installed && !value.updateAvailable
        : value.state === 'update-available'
          ? value.deliveryAvailable && value.installed && value.updateAvailable
          : !value.updateAvailable;
  if (!stateInvariant
      || value.deliveryAvailable !== (value.downloadBytes > 0 && value.availableInstalledBytes > 0)
      || (!value.installed && (version !== null || value.installedBytes !== 0))) {
    throw invalidResponse();
  }
  return Object.freeze({
    ...value,
    version,
    availableVersion,
    operation: value.operation === null ? null : normalizeOperation(value.operation),
  });
};

const normalizeError = (value) => {
  if (!hasExactKeys(value, ERROR_KEYS)
      || typeof value.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value.code)
      || !safeText(value.message)) throw invalidResponse();
  return Object.freeze({ code: value.code, message: value.message });
};

export const normalizeRenderPackageEvent = (value) => {
  if (!isPlainRecord(value) || !['progress', 'completed', 'cancelled', 'failed'].includes(value.event)) {
    throw invalidResponse();
  }
  if (value.event === 'progress') {
    if (!hasExactKeys(value, new Set(['event', 'operation']))) throw invalidResponse();
    return Object.freeze({ event: value.event, operation: normalizeOperation(value.operation) });
  }
  const expected = value.event === 'failed'
    ? new Set(['event', 'job', 'package', 'action', 'error'])
    : new Set(['event', 'job', 'package', 'action']);
  if (!hasExactKeys(value, expected)
      || value.package !== PACKAGE_ID
      || !ACTIONS.has(value.action)) throw invalidResponse();
  const job = value.job === null ? null : normalizeRenderPackageJob(value.job);
  if (value.event !== 'failed' && job === null) throw invalidResponse();
  return Object.freeze({
    ...value,
    job,
    ...(value.event === 'failed' ? { error: normalizeError(value.error) } : {}),
  });
};

export const createRenderPackageService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const channels = new Map();
  const requireDesktop = () => {
    if (!isNativeRuntime()) throw invalidRequest();
  };
  const cancelRenderPackageJob = async (id) => {
    requireDesktop();
    if (!isUuidV7(id)) throw invalidRequest();
    await invokeCommand('job_cancel', { id });
  };
  const start = async (command, action, handlers = {}, options = {}) => {
    requireDesktop();
    if (!isPlainRecord(handlers) || !isPlainRecord(options)) throw invalidRequest();
    const signal = options.signal;
    if (signal !== undefined && (!isRecord(signal) || typeof signal.addEventListener !== 'function')) {
      throw invalidRequest();
    }
    let initial = null;
    let terminal = false;
    let protocolError = null;
    let cancelIssued = false;
    let lastSequence = -1;
    let lastBasisPoints = -1;
    const pending = [];
    const safeCall = (name, value) => {
      try { handlers[name]?.(value); } catch (error) {
        try { handlers.onHandlerError?.(error); } catch { /* isolated */ }
      }
    };
    const release = () => {
      signal?.removeEventListener?.('abort', cancel);
      if (initial) channels.delete(initial.id);
    };
    const cancel = () => {
      if (!initial || terminal || cancelIssued) return;
      cancelIssued = true;
      cancelRenderPackageJob(initial.id).catch((error) => safeCall('onCancellationError', error));
    };
    const failProtocol = () => {
      if (protocolError || terminal) return;
      protocolError = invalidResponse();
      safeCall('onProtocolError', protocolError);
      cancel();
    };
    const dispatch = (event) => {
      if (protocolError || terminal) return;
      const job = event.event === 'progress' ? event.operation.job : event.job;
      const eventAction = event.event === 'progress' ? event.operation.action : event.action;
      if (eventAction !== action || (job && initial && job.id !== initial.id)
          || (job && job.sequence <= lastSequence)
          || (event.event === 'progress' && event.operation.basisPoints < lastBasisPoints)) {
        failProtocol();
        return;
      }
      if (job) {
        lastSequence = job.sequence;
        lastBasisPoints = job.progress.basisPoints;
      }
      if (event.event !== 'progress') {
        terminal = true;
        release();
      }
      safeCall('onEvent', event);
      safeCall(`on${event.event[0].toUpperCase()}${event.event.slice(1)}`, event);
    };
    const channel = new ChannelConstructor();
    channel.onmessage = (raw) => {
      let event;
      try { event = normalizeRenderPackageEvent(raw); } catch { failProtocol(); return; }
      if (!initial) {
        if (pending.length >= MAX_PENDING_EVENTS) failProtocol();
        else pending.push(event);
      } else dispatch(event);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      initial = normalizeRenderPackageJob(await invokeCommand(command, { onEvent: channel }));
      if (!['queued', 'running'].includes(initial.state)) throw invalidResponse();
      lastSequence = initial.sequence;
      lastBasisPoints = initial.progress.basisPoints;
      if (protocolError) {
        cancel();
        throw protocolError;
      }
      channels.set(initial.id, channel);
      pending.splice(0).forEach(dispatch);
      if (signal?.aborted) cancel();
      if (terminal) release();
      return initial;
    } catch (error) {
      pending.length = 0;
      release();
      throw error;
    }
  };
  return Object.freeze({
    getRenderPackageStatus: async () => {
      requireDesktop();
      return normalizeRenderPackageStatus(await invokeCommand('render_package_status'));
    },
    installRenderPackage: (handlers, options) => start(
      'render_package_install', 'install', handlers, options
    ),
    removeRenderPackage: (handlers, options) => start(
      'render_package_remove', 'remove', handlers, options
    ),
    cancelRenderPackageJob,
  });
};

const renderPackageService = createRenderPackageService();
export const getRenderPackageStatus = renderPackageService.getRenderPackageStatus;
export const installRenderPackage = renderPackageService.installRenderPackage;
export const removeRenderPackage = renderPackageService.removeRenderPackage;
export const cancelRenderPackageJob = renderPackageService.cancelRenderPackageJob;
