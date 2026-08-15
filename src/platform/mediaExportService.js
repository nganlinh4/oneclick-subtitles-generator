import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const MAX_PENDING_EVENTS = 4096;
const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const activeJobStates = new Set(['queued', 'running', 'cancelling']);
const cancellationResponseStates = new Set([
  'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const mediaExportCommandCodes = new Set([
  'internal',
  'mediaUnavailable',
  'invalidMediaLocation',
  'mediaIdentityConflict',
  'unsafeExportDestination',
  'mediaSourceChanged',
  'mediaExportFailed',
  'jobAlreadyExists',
  'jobNotFound',
  'jobConflict',
  'invalidJob',
  'invalidJobState',
  'jobSequenceLimit',
  'jobRegistry',
  'database',
]);
const mediaExportEventCodes = new Set([
  'unsafeExportDestination', 'mediaSourceChanged', 'mediaExportFailed',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const snapshotPlainRecord = (value) => {
  try {
    if (!isRecord(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null)
        || Object.getOwnPropertySymbols(value).length !== 0) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !('value' in descriptor)
    )) {
      return null;
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
    ));
  } catch {
    return null;
  }
};

const snapshotExactRecord = (value, expected) => {
  const snapshot = snapshotPlainRecord(value);
  if (snapshot === null) return null;
  const actual = Object.keys(snapshot).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
    ? snapshot
    : null;
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

const mediaExportFailureMessage = (code) => (
  code === 'unsafeExportDestination'
    ? 'The selected export destination is unsafe or unavailable'
    : code === 'mediaSourceChanged'
      ? 'The stored media changed while it was being exported'
      : ['mediaUnavailable', 'invalidMediaLocation', 'mediaIdentityConflict'].includes(code)
        ? 'The stored media is no longer available'
        : 'The native media export could not be completed'
);

const normalizeFailure = (error) => {
  try {
    if (error instanceof MediaExportError) return error;
  } catch {
    // Hostile transport proxies are never authoritative error metadata.
  }
  let code = 'mediaExportFailed';
  try {
    const candidate = error?.code;
    if (mediaExportCommandCodes.has(candidate)) code = candidate;
  } catch {
    // Keep the fixed local failure if an accessor or Proxy trap throws.
  }
  return new MediaExportError(code, mediaExportFailureMessage(code));
};

export const normalizeMediaExportJob = (value) => {
  const snapshot = snapshotExactRecord(value, ['id', 'kind', 'state', 'progress', 'sequence']);
  const progress = snapshot === null
    ? null
    : snapshotExactRecord(snapshot.progress, ['basisPoints']);
  if (snapshot === null || progress === null
      || !isUuidV7(snapshot.id)
      || snapshot.kind !== 'exportMedia'
      || !jobStates.has(snapshot.state)
      || !isSafeInteger(progress.basisPoints)
      || progress.basisPoints > 10000
      || !isSafeInteger(snapshot.sequence)
      || (snapshot.state === 'queued'
        && (progress.basisPoints !== 0 || snapshot.sequence !== 0))
      || (snapshot.state === 'succeeded'
        && (progress.basisPoints !== 10000 || snapshot.sequence < 2))
      || (snapshot.state !== 'queued' && snapshot.sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    ...snapshot,
    progress: Object.freeze({ basisPoints: progress.basisPoints }),
  });
};

const normalizeError = (value) => {
  const snapshot = snapshotExactRecord(value, ['code', 'message']);
  if (snapshot === null || typeof snapshot.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(snapshot.code)
      || typeof snapshot.message !== 'string') {
    throw invalidResponse();
  }
  const code = mediaExportEventCodes.has(snapshot.code) ? snapshot.code : 'mediaExportFailed';
  return Object.freeze({ code, message: mediaExportFailureMessage(code) });
};

export const normalizeMediaExportEvent = (value) => {
  const eventSnapshot = snapshotPlainRecord(value);
  if (eventSnapshot === null || typeof eventSnapshot.event !== 'string') throw invalidResponse();
  switch (eventSnapshot.event) {
    case 'progress': {
      const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job']);
      if (snapshot === null) throw invalidResponse();
      const job = normalizeMediaExportJob(snapshot.job);
      if (job.state !== 'running') throw invalidResponse();
      return Object.freeze({ event: 'progress', job });
    }
    case 'completed': {
      const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job', 'bytesWritten']);
      if (snapshot === null || !Number.isSafeInteger(snapshot.bytesWritten)
          || snapshot.bytesWritten <= 0) {
        throw invalidResponse();
      }
      const job = normalizeMediaExportJob(snapshot.job);
      if (job.state !== 'succeeded') throw invalidResponse();
      return Object.freeze({ event: 'completed', job, bytesWritten: snapshot.bytesWritten });
    }
    case 'cancelled': {
      const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job']);
      if (snapshot === null) throw invalidResponse();
      const job = normalizeMediaExportJob(snapshot.job);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job });
    }
    case 'failed': {
      const snapshot = snapshotExactRecord(eventSnapshot, ['event', 'job', 'error']);
      if (snapshot === null) throw invalidResponse();
      const job = snapshot.job === null ? null : normalizeMediaExportJob(snapshot.job);
      if (job !== null && job.state !== 'failed') throw invalidResponse();
      return Object.freeze({ event: 'failed', job, error: normalizeError(snapshot.error) });
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
  const snapshot = snapshotPlainRecord(handlers);
  if (snapshot === null || Object.keys(snapshot).some((key) => !allowed.includes(key))) {
    throw invalidRequest();
  }
  if (Object.values(snapshot).some(
    (handler) => handler !== undefined && typeof handler !== 'function'
  )) {
    throw invalidRequest();
  }
  return snapshot;
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
    let protocolCancellation = null;

    const call = (handler, event) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(event);
        if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
      } catch {
        // Presentation callbacks cannot break or mutate the native export lifecycle.
      }
    };
    const requestProtocolCancellation = () => {
      if (initial === null || protocolCancellation !== null || terminal) {
        return protocolCancellation;
      }
      activeChannels.delete(initial.id);
      protocolCancellation = cancel(initial.id).catch(() => null);
      return protocolCancellation;
    };
    const protocolError = () => {
      if (protocolFailed) return;
      protocolFailed = true;
      pending.length = 0;
      call(handlers.onProtocolError, invalidResponse());
      requestProtocolCancellation();
    };
    const dispatch = (event) => {
      if (protocolFailed) return;
      const eventJob = event.job;
      if (terminal
          || eventJob === null
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
      if (protocolFailed) return;
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
      if (!protocolFailed && pending.length > 0 && pending[0].job !== null) {
        initial = pending[0].job;
        lastSequence = -1;
        lastProgress = 0;
        for (const event of pending.splice(0)) {
          dispatch(event);
          if (protocolFailed) break;
        }
        if (!terminal) await requestProtocolCancellation();
      } else {
        pending.length = 0;
      }
      throw normalizeFailure(error);
    }
    if (rawInitial === null) {
      if (pending.length > 0 || protocolFailed) throw invalidResponse();
      return null;
    }
    try {
      initial = normalizeMediaExportJob(rawInitial);
    } catch (error) {
      const snapshot = snapshotPlainRecord(rawInitial)?.id ?? null;
      if (isUuidV7(snapshot)) {
        initial = Object.freeze({ id: snapshot });
        await requestProtocolCancellation();
      }
      throw error;
    }
    if (initial.state !== 'running') {
      if (activeJobStates.has(initial.state)) await requestProtocolCancellation();
      throw invalidResponse();
    }
    if (protocolFailed) {
      await requestProtocolCancellation();
      throw invalidResponse();
    }
    lastSequence = initial.sequence;
    lastProgress = initial.progress.basisPoints;
    activeChannels.set(initial.id, channel);
    for (const event of pending.splice(0)) {
      dispatch(event);
      if (protocolFailed) break;
    }
    if (protocolFailed) {
      await requestProtocolCancellation();
      throw invalidResponse();
    }
    if (terminal) activeChannels.delete(initial.id);
    return initial;
  };

  const cancel = async (id) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    if (!isUuidV7(id)) throw invalidRequest();
    try {
      const job = normalizeMediaExportJob(await invokeCommand('job_cancel', { id }));
      if (job.id !== id || !cancellationResponseStates.has(job.state)) {
        throw invalidResponse();
      }
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

export const exportMediaAsset = async (
  assetId,
  { onStarted, onProgress } = {},
  service = mediaExportService,
) => {
  let terminalObserved = false;
  let terminalOutcome = null;
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const settle = (outcome) => {
    if (terminalOutcome !== null) return;
    terminalObserved = true;
    terminalOutcome = outcome;
    resolveTerminal(outcome);
  };
  let initial;
  try {
    initial = await service.start(assetId, {
      onProgress,
      onCompleted: (event) => settle({
        result: Object.freeze({ status: 'completed', ...event }),
      }),
      onCancelled: (event) => settle({
        result: Object.freeze({ status: 'cancelled', ...event }),
      }),
      onFailed: (event) => settle({ error: normalizeFailure(event.error) }),
      onProtocolError: (error) => settle({ error }),
    });
  } catch (error) {
    if (!terminalObserved) throw normalizeFailure(error);
    const outcome = terminalOutcome ?? await terminal;
    if (outcome.error) throw outcome.error;
    return outcome.result;
  }
  if (initial === null) return Object.freeze({ status: 'dialogCancelled' });
  if (!terminalObserved && typeof onStarted === 'function') {
    try {
      onStarted(initial);
    } catch {
      // Presentation callbacks cannot break the native export lifecycle.
    }
  }
  const outcome = await terminal;
  if (outcome.error) throw outcome.error;
  return outcome.result;
};
