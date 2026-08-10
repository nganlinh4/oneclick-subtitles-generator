import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const MAX_PENDING_EVENTS = 4096;
const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, expected) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const isSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export class MediaExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaExportError';
    this.code = code;
  }
}

const invalidRequest = () => new MediaExportError(
  'invalidMediaExportRequest',
  'The native media export request is invalid'
);

const invalidResponse = () => new MediaExportError(
  'invalidMediaExportResponse',
  'The desktop host returned invalid media export data'
);

const runtimeRequired = () => new MediaExportError(
  'desktopRuntimeUnavailable',
  'Media export requires the desktop runtime'
);

const normalizeFailure = (error) => {
  if (error instanceof MediaExportError) return error;
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : 'mediaExportFailed';
  return new MediaExportError(code, 'The native media export could not be completed');
};

export const normalizeMediaExportJob = (value) => {
  if (!hasExactKeys(value, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !isUuidV7(value.id)
      || value.kind !== 'exportMedia'
      || !jobStates.has(value.state)
      || !hasExactKeys(value.progress, ['basisPoints'])
      || !isSafeInteger(value.progress.basisPoints)
      || value.progress.basisPoints > 10000
      || !isSafeInteger(value.sequence)
      || (value.state === 'queued'
        && (value.progress.basisPoints !== 0 || value.sequence !== 0))
      || (value.state === 'succeeded'
        && (value.progress.basisPoints !== 10000 || value.sequence < 2))
      || (value.state !== 'queued' && value.sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    ...value,
    progress: Object.freeze({ basisPoints: value.progress.basisPoints }),
  });
};

const normalizeError = (value) => {
  if (!hasExactKeys(value, ['code', 'message'])
      || typeof value.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value.code)
      || typeof value.message !== 'string') {
    throw invalidResponse();
  }
  return Object.freeze({
    code: value.code,
    message: 'The native media export could not be completed',
  });
};

export const normalizeMediaExportEvent = (value) => {
  if (!isRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  switch (value.event) {
    case 'progress': {
      if (!hasExactKeys(value, ['event', 'job'])) throw invalidResponse();
      const job = normalizeMediaExportJob(value.job);
      if (job.state !== 'running') throw invalidResponse();
      return Object.freeze({ event: 'progress', job });
    }
    case 'completed': {
      if (!hasExactKeys(value, ['event', 'job', 'bytesWritten'])
          || !Number.isSafeInteger(value.bytesWritten)
          || value.bytesWritten <= 0) {
        throw invalidResponse();
      }
      const job = normalizeMediaExportJob(value.job);
      if (job.state !== 'succeeded') throw invalidResponse();
      return Object.freeze({ event: 'completed', job, bytesWritten: value.bytesWritten });
    }
    case 'cancelled': {
      if (!hasExactKeys(value, ['event', 'job'])) throw invalidResponse();
      const job = normalizeMediaExportJob(value.job);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job });
    }
    case 'failed': {
      if (!hasExactKeys(value, ['event', 'job', 'error'])) throw invalidResponse();
      const job = value.job === null ? null : normalizeMediaExportJob(value.job);
      if (job !== null && job.state !== 'failed') throw invalidResponse();
      return Object.freeze({ event: 'failed', job, error: normalizeError(value.error) });
    }
    default:
      throw invalidResponse();
  }
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const allowed = [
    'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError',
  ];
  if (!isPlainRecord(handlers) || Object.keys(handlers).some((key) => !allowed.includes(key))) {
    throw invalidRequest();
  }
  if (Object.values(handlers).some(
    (handler) => handler !== undefined && typeof handler !== 'function'
  )) {
    throw invalidRequest();
  }
  return Object.freeze({ ...handlers });
};

export const createMediaExportService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const start = async (assetId, rawHandlers) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    if (!isUuidV7(assetId)) throw invalidRequest();
    const handlers = normalizeHandlers(rawHandlers);
    const pending = [];
    let initial = null;
    let lastSequence = null;
    let lastProgress = 0;
    let terminal = false;
    let protocolFailed = false;

    const call = (handler, event) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(event);
        if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
      } catch {
        // Presentation callbacks cannot break or mutate the native export lifecycle.
      }
    };
    const protocolError = () => {
      if (protocolFailed) return;
      protocolFailed = true;
      call(handlers.onProtocolError, invalidResponse());
      if (initial !== null && !terminal) {
        invokeCommand('job_cancel', { id: initial.id }).catch(() => undefined);
      }
    };
    const dispatch = (event) => {
      const eventJob = event.job;
      if (terminal
          || (eventJob === null && event.event !== 'failed')
          || (eventJob !== null && (eventJob.id !== initial.id
            || eventJob.sequence <= lastSequence
            || eventJob.progress.basisPoints < lastProgress))) {
        protocolError();
        return;
      }
      if (eventJob !== null) {
        lastSequence = eventJob.sequence;
        lastProgress = eventJob.progress.basisPoints;
      }
      if (event.event !== 'progress') {
        terminal = true;
        activeChannels.delete(initial.id);
      }
      call(handlers.onEvent, event);
      if (event.event === 'progress') call(handlers.onProgress, event);
      if (event.event === 'completed') call(handlers.onCompleted, event);
      if (event.event === 'cancelled') call(handlers.onCancelled, event);
      if (event.event === 'failed') call(handlers.onFailed, event);
    };

    const channel = new ChannelConstructor();
    channel.onmessage = (rawEvent) => {
      let event;
      try {
        event = normalizeMediaExportEvent(rawEvent);
      } catch {
        protocolError();
        return;
      }
      if (initial === null) {
        if (pending.length >= MAX_PENDING_EVENTS) {
          protocolError();
          return;
        }
        pending.push(event);
        return;
      }
      dispatch(event);
    };

    let rawInitial;
    try {
      rawInitial = await invokeCommand('media_export_start', {
        request: { assetId },
        onEvent: channel,
      });
    } catch (error) {
      pending.length = 0;
      throw normalizeFailure(error);
    }
    if (rawInitial === null) {
      if (pending.length > 0 || protocolFailed) throw invalidResponse();
      return null;
    }
    initial = normalizeMediaExportJob(rawInitial);
    if (initial.state !== 'running') throw invalidResponse();
    if (protocolFailed) {
      invokeCommand('job_cancel', { id: initial.id }).catch(() => undefined);
      throw invalidResponse();
    }
    lastSequence = initial.sequence;
    lastProgress = initial.progress.basisPoints;
    activeChannels.set(initial.id, channel);
    pending.splice(0).forEach(dispatch);
    if (terminal) activeChannels.delete(initial.id);
    return initial;
  };

  const cancel = async (id) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    if (!isUuidV7(id)) throw invalidRequest();
    try {
      const job = normalizeMediaExportJob(await invokeCommand('job_cancel', { id }));
      if (job.id !== id) throw invalidResponse();
      return job;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  return Object.freeze({ start, cancel });
};

const mediaExportService = createMediaExportService();

export const startMediaExport = mediaExportService.start;
export const cancelMediaExport = mediaExportService.cancel;

export const exportMediaAsset = async (assetId, {
  onStarted,
  onProgress,
} = {}) => {
  let settle;
  const terminal = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const initial = await startMediaExport(assetId, {
    onProgress,
    onCompleted: (event) => settle.resolve(Object.freeze({ status: 'completed', ...event })),
    onCancelled: (event) => settle.resolve(Object.freeze({ status: 'cancelled', ...event })),
    onFailed: (event) => settle.reject(normalizeFailure(event.error)),
    onProtocolError: (error) => settle.reject(error),
  });
  if (initial === null) return Object.freeze({ status: 'dialogCancelled' });
  if (typeof onStarted === 'function') {
    try {
      onStarted(initial);
    } catch {
      // Presentation callbacks cannot break the native export lifecycle.
    }
  }
  return terminal;
};
