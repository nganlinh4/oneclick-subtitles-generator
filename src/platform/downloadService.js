import { Channel } from '@tauri-apps/api/core';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import {
  ensureNativeDownloadInspectionReady,
  ensureNativeDownloadReady,
  recoverNativeDownloaderAfterFailure,
} from './nativeDownloadPreflight';
import {
  activeJobStates,
  cancellationResponseStates,
  invalidRequest,
  invalidResponse,
  jobStates,
  MAX_PENDING_EVENTS,
  normalizeInvocationFailure,
  runtimeRequired,
} from './downloadServiceContract';
import {
  normalizeHandlers,
  normalizeInspectRequest,
  normalizeStartRequest,
} from './downloadRequestNormalizers';
import {
  downloadEventKeys,
  normalizeDownloadEvent,
  normalizeInspection,
  normalizeJob,
  normalizeStatus,
} from './downloadResponseNormalizers';
import { createChannelEnvelopeSnapshots } from './nativeChannelEnvelope';
import { isUuidVersion } from './nativeDataSnapshot';

export { DownloadServiceError } from './downloadServiceContract';
export { normalizeDownloadEvent } from './downloadResponseNormalizers';

const { snapshotEventEnvelope, snapshotJobEnvelope } = createChannelEnvelopeSnapshots({
  eventKeys: downloadEventKeys,
  isJobId: (value) => isUuidVersion(value, 7),
  jobKind: 'downloadMedia',
  jobStates,
});

const triggerNativeDownloaderRecovery = () => {
  try {
    Promise.resolve(recoverNativeDownloaderAfterFailure()).catch(() => undefined);
  } catch {
    // Automatic recovery is best-effort and cannot create an orphan rejection.
  }
};

export const createNativeDownloadService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const invoke = async (command, args, normalize) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    let rawValue;
    try {
      rawValue = await invokeCommand(command, args);
    } catch (error) {
      throw normalizeInvocationFailure(error);
    }
    return normalize(rawValue);
  };

  const getStatus = () => invoke('download_status', {}, normalizeStatus);

  const inspectUrl = (request) => invoke(
    'download_inspect',
    { request: normalizeInspectRequest(request) },
    normalizeInspection
  );

  const cancelNativeJob = (jobId) => invoke('download_cancel', { jobId }, (value) => {
    const snapshot = normalizeJob(value);
    if (snapshot.id !== jobId || !cancellationResponseStates.has(snapshot.state)) {
      throw invalidResponse();
    }
    return snapshot;
  });

  const releaseEntry = (entry) => {
    entry.quarantined = true;
    if (activeChannels.get(entry.id) === entry) activeChannels.delete(entry.id);
    try {
      entry.channel.onmessage = () => undefined;
    } catch {
      // The map is still released even if a custom test channel rejects reassignment.
    }
  };

  const cancelEntry = (entry) => {
    if (entry.cancelPromise !== null) return entry.cancelPromise;
    entry.cancelPromise = cancelNativeJob(entry.id).then((snapshot) => {
      if (snapshot.state !== 'cancelling') entry.consumeCancelSnapshot(snapshot);
      return snapshot;
    });
    return entry.cancelPromise;
  };

  const cancelDownload = (jobId) => {
    if (!isUuidVersion(jobId, 7)) return Promise.reject(invalidRequest());
    if (!isNativeRuntime()) return Promise.reject(runtimeRequired());
    const entry = activeChannels.get(jobId);
    return entry === undefined ? cancelNativeJob(jobId) : cancelEntry(entry);
  };

  const startDownload = async (request, rawHandlers) => {
    if (!isNativeRuntime()) throw runtimeRequired();
    const normalizedRequest = normalizeStartRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const pending = [];
    let initial = null;
    let terminal = false;
    let protocolFailed = false;
    let ownedEntry = null;
    let ledger = null;

    const call = (handler, event) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(event);
        Promise.resolve(returned).catch(() => undefined);
      } catch {
        // UI handlers cannot break the native Channel protocol.
      }
    };

    const bindOwned = (identity) => {
      if (identity === null || !activeJobStates.has(identity.state) && identity.state !== 'queued') {
        return ownedEntry;
      }
      if (ownedEntry === null) {
        ownedEntry = {
          id: identity.id,
          channel,
          cancelPromise: null,
          consumeCancelSnapshot,
          quarantined: false,
        };
      }
      return ownedEntry;
    };

    const requestProtocolCancellation = () => {
      if (ownedEntry === null) return null;
      const cancellation = cancelEntry(ownedEntry);
      cancellation.catch(() => undefined);
      return cancellation;
    };

    const awaitProtocolCancellation = async () => {
      const cancellation = requestProtocolCancellation();
      if (cancellation !== null) await cancellation.catch(() => null);
    };

    const protocolError = () => {
      if (terminal || protocolFailed) return;
      protocolFailed = true;
      pending.length = 0;
      if (ownedEntry !== null) {
        requestProtocolCancellation();
        releaseEntry(ownedEntry);
      }
      call(handlers.onProtocolError, invalidResponse());
    };

    const recordEvent = (event) => {
      if (event.job === null
          || event.job.sequence < ledger.sequence
          || event.job.progress.basisPoints < ledger.basisPoints) {
        throw invalidResponse();
      }
      if (event.job.sequence === ledger.sequence) {
        if (event.job.state !== ledger.state
            || event.job.progress.basisPoints !== ledger.basisPoints) {
          throw invalidResponse();
        }
        return;
      }
      ledger.sequence = event.job.sequence;
      ledger.state = event.job.state;
      ledger.basisPoints = event.job.progress.basisPoints;
    };

    const dispatch = (event) => {
      if (terminal || protocolFailed) return;
      const eventJobId = event.job?.id;
      if (eventJobId === undefined || eventJobId !== initial.id) {
        protocolError();
        return;
      }
      try {
        recordEvent(event);
      } catch {
        protocolError();
        return;
      }
      if (event.event !== 'progress') {
        terminal = true;
        releaseEntry(ownedEntry);
      }
      // Download retry belongs to nativeUrlDownloadAdapter. Starting a second, detached refresh
      // here races the adapter's terminal handling: it can observe the still-releasing runtime,
      // return without installing, and consume the global recovery cooldown before the owned
      // retry asks for it. Direct inspection has no adapter-owned retry and remains handled by
      // inspectDownloadUrl below.
      call(handlers.onEvent, event);
      if (event.event === 'progress') call(handlers.onProgress, event);
      if (event.event === 'completed') call(handlers.onCompleted, event);
      if (event.event === 'cancelled') call(handlers.onCancelled, event);
      if (event.event === 'failed') call(handlers.onFailed, event);
    };

    function consumeCancelSnapshot(jobSnapshot) {
      if (terminal || protocolFailed || jobSnapshot.state === 'cancelling') return;
      if (jobSnapshot.state === 'cancelled') {
        const event = Object.freeze({ event: 'cancelled', job: jobSnapshot });
        terminal = true;
        pending.length = 0;
        const onEvent = handlers.onEvent;
        const onCancelled = handlers.onCancelled;
        releaseEntry(ownedEntry);
        call(onEvent, event);
        call(onCancelled, event);
        return;
      }
      protocolFailed = true;
      pending.length = 0;
      const onProtocolError = handlers.onProtocolError;
      releaseEntry(ownedEntry);
      call(onProtocolError, invalidResponse());
    }

    const channel = new ChannelConstructor();
    channel.onmessage = (rawEvent) => {
      if (terminal || protocolFailed) return;
      const envelope = snapshotEventEnvelope(rawEvent);
      const identity = envelope?.identity ?? null;
      if (identity !== null) {
        if (ownedEntry === null) bindOwned(identity);
        else if (ownedEntry.id !== identity.id) {
          protocolError();
          return;
        }
      }
      let event;
      try {
        if (envelope === null || !envelope.valid) throw invalidResponse();
        event = normalizeDownloadEvent(envelope.value);
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

    let rawSnapshot;
    try {
      rawSnapshot = await invokeCommand('download_start', {
        request: normalizedRequest,
        onEvent: channel,
      });
    } catch (error) {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw normalizeInvocationFailure(error);
    }

    const returnedEnvelope = snapshotJobEnvelope(rawSnapshot);
    const returnedIdentity = returnedEnvelope?.identity ?? null;
    if (ownedEntry === null && returnedIdentity !== null) bindOwned(returnedIdentity);

    let snapshot;
    try {
      if (returnedEnvelope === null || !returnedEnvelope.valid) throw invalidResponse();
      snapshot = normalizeJob(returnedEnvelope.value);
    } catch {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw invalidResponse();
    }

    if (ownedEntry !== null && ownedEntry.id !== snapshot.id) {
      pending.length = 0;
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      await awaitProtocolCancellation();
      throw invalidResponse();
    }

    initial = snapshot;
    if (snapshot.state !== 'running') {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw invalidResponse();
    }
    if (protocolFailed) {
      terminal = true;
      releaseEntry(ownedEntry);
      await awaitProtocolCancellation();
      throw invalidResponse();
    }
    if (ownedEntry === null) bindOwned(snapshot);
    ledger = {
      sequence: snapshot.sequence,
      state: snapshot.state,
      basisPoints: snapshot.progress.basisPoints,
    };
    const existingEntry = activeChannels.get(snapshot.id);
    if (existingEntry !== undefined && existingEntry !== ownedEntry) {
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      throw invalidResponse();
    }
    activeChannels.set(snapshot.id, ownedEntry);
    for (const event of pending.splice(0)) {
      dispatch(event);
      if (protocolFailed) break;
    }
    if (protocolFailed) {
      terminal = true;
      releaseEntry(ownedEntry);
      await awaitProtocolCancellation();
      throw invalidResponse();
    }
    return snapshot;
  };

  return Object.freeze({ getStatus, inspectUrl, startDownload, cancelDownload });
};

const downloadService = createNativeDownloadService();

export const inspectDownloadUrl = async (request, preflightOptions) => {
  const normalizedRequest = normalizeInspectRequest(request);
  const readiness = await downloadService.getStatus();
  await ensureNativeDownloadInspectionReady(readiness, preflightOptions);
  try {
    return await downloadService.inspectUrl(normalizedRequest);
  } catch (error) {
    if (error?.code === 'downloaderExecutionFailed') {
      triggerNativeDownloaderRecovery();
    }
    throw error;
  }
};
export const startDownload = async (request, handlers, preflightOptions) => {
  const normalizedRequest = normalizeStartRequest(request);
  const normalizedHandlers = normalizeHandlers(handlers);
  const readiness = await downloadService.getStatus();
  await ensureNativeDownloadReady(readiness, preflightOptions);
  return downloadService.startDownload(normalizedRequest, normalizedHandlers);
};
export const cancelDownload = downloadService.cancelDownload;
