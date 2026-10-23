import { Channel } from '@tauri-apps/api/core';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import {
  activeJobStates,
  cancellationResponseStates,
  cancelledOperation,
  expectedJobKind,
  invalidRequest,
  invalidResponse,
  isUuidV7,
  jobStates,
  MAX_PENDING_EVENTS,
  MediaPipelineServiceError,
  mediaPipelineEventKeys,
  normalizeFailure,
  phaseRanks,
  requireAssetId,
  runtimeRequired,
} from './mediaPipelineContract';
import {
  normalizeHandlers,
  normalizeMediaPipelineRequest,
  normalizeRunOptions,
} from './mediaPipelineRequests';
import {
  normalizeInspection,
  normalizeJob,
  normalizeMediaPipelineEvent,
} from './mediaPipelineResponses';
import { createChannelEnvelopeSnapshots } from './nativeChannelEnvelope';

export { MediaPipelineServiceError } from './mediaPipelineContract';
export { normalizeMediaPipelineRequest } from './mediaPipelineRequests';
export { normalizeMediaPipelineEvent } from './mediaPipelineResponses';

export const createNativeMediaPipelineService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const requireRuntime = () => {
    if (!isNativeRuntime()) throw runtimeRequired();
  };

  const inspect = async (assetId) => {
    requireRuntime();
    const normalizedAssetId = requireAssetId(assetId);
    let rawValue;
    try {
      rawValue = await invokeCommand('media_pipeline_inspect', { assetId: normalizedAssetId });
    } catch (error) {
      throw normalizeFailure(error);
    }
    return normalizeInspection(rawValue, normalizedAssetId);
  };

  const releaseEntry = (entry) => {
    entry.quarantined = true;
    if (activeChannels.get(entry.id) === entry) activeChannels.delete(entry.id);
    try {
      entry.channel.onmessage = () => undefined;
    } catch {
      // The active entry is still released for custom channels that reject reassignment.
    }
  };

  const cancelNativeJob = async (jobId, jobKind = null) => {
    let rawValue;
    try {
      rawValue = await invokeCommand('media_pipeline_cancel', { jobId });
    } catch (error) {
      throw normalizeFailure(error);
    }
    const job = normalizeJob(rawValue, jobKind);
    if (job.id !== jobId || !cancellationResponseStates.has(job.state)) {
      throw invalidResponse();
    }
    return job;
  };

  const cancelEntry = (entry) => {
    if (entry.cancelPromise !== null) return entry.cancelPromise;
    entry.cancelPromise = cancelNativeJob(entry.id, entry.jobKind).then((job) => {
      if (job.state !== 'cancelling') entry.consumeCancelSnapshot(job);
      return job;
    });
    return entry.cancelPromise;
  };

  const cancel = async (jobId) => {
    requireRuntime();
    if (!isUuidV7(jobId)) throw invalidRequest();
    const entry = activeChannels.get(jobId);
    return entry === undefined ? cancelNativeJob(jobId) : cancelEntry(entry);
  };

  const start = async (rawRequest, rawHandlers) => {
    requireRuntime();
    const request = normalizeMediaPipelineRequest(rawRequest);
    const handlers = normalizeHandlers(rawHandlers);
    const pending = [];
    let initial = null;
    let terminal = false;
    let protocolFailed = false;
    let ownedEntry = null;
    let ledger = null;
    const jobKind = expectedJobKind(request.operation);
    const eventExpectation = Object.freeze({
      operation: request.operation,
      assetId: request.assetId,
    });

    const call = (handler, value) => {
      if (typeof handler !== 'function') return;
      try {
        const returned = handler(value);
        Promise.resolve(returned).catch(() => undefined);
      } catch {
        // UI handlers cannot corrupt the native channel lifecycle.
      }
    };
    const bindOwned = (identity) => {
      if (identity === null || !activeJobStates.has(identity.state) && identity.state !== 'queued') {
        return ownedEntry;
      }
      if (ownedEntry === null) {
        ownedEntry = {
          id: identity.id,
          jobKind,
          channel,
          cancelPromise: null,
          consumeCancelSnapshot,
          quarantined: false,
        };
      }
      return ownedEntry;
    };

    const { snapshotEventEnvelope, snapshotJobEnvelope } = createChannelEnvelopeSnapshots({
      eventKeys: mediaPipelineEventKeys,
      isJobId: isUuidV7,
      jobKind,
      jobStates,
    });

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
      if (event.job.sequence === ledger.sequence
          && (event.job.state !== ledger.state
            || event.job.progress.basisPoints !== ledger.basisPoints)) {
        throw invalidResponse();
      }
      if (event.event === 'progress') {
        const rank = phaseRanks[event.phase];
        if (rank < ledger.phaseRank
            || (rank === ledger.phaseRank
              && event.fraction !== null
              && ledger.fraction !== null
              && event.fraction < ledger.fraction)) {
          throw invalidResponse();
        }
        ledger.phaseRank = rank;
        ledger.fraction = event.fraction;
      }
      if (event.job.sequence > ledger.sequence) {
        ledger.sequence = event.job.sequence;
        ledger.state = event.job.state;
        ledger.basisPoints = event.job.progress.basisPoints;
      }
    };

    const dispatch = (event) => {
      if (terminal || protocolFailed) return;
      if (event.job === null || event.job.id !== initial.id) {
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
      call(handlers.onEvent, event);
      if (event.event === 'progress') call(handlers.onProgress, event);
      if (event.event === 'completed') call(handlers.onCompleted, event);
      if (event.event === 'cancelled') call(handlers.onCancelled, event);
      if (event.event === 'failed') call(handlers.onFailed, event);
    };

    function consumeCancelSnapshot(jobSnapshot) {
      if (terminal || protocolFailed || jobSnapshot.state === 'cancelling') return;
      if (jobSnapshot.state === 'cancelled') {
        const event = Object.freeze({
          event: 'cancelled',
          job: jobSnapshot,
          operation: request.operation,
        });
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
        event = normalizeMediaPipelineEvent(envelope.value, eventExpectation);
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
      rawInitial = await invokeCommand('media_pipeline_start', {
        request,
        onEvent: channel,
      });
    } catch (error) {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw normalizeFailure(error);
    }

    const returnedEnvelope = snapshotJobEnvelope(rawInitial);
    const returnedIdentity = returnedEnvelope?.identity ?? null;
    if (ownedEntry === null && returnedIdentity !== null) bindOwned(returnedIdentity);

    try {
      if (returnedEnvelope === null || !returnedEnvelope.valid) throw invalidResponse();
      initial = normalizeJob(returnedEnvelope.value, jobKind);
    } catch {
      pending.length = 0;
      terminal = true;
      if (ownedEntry !== null) {
        releaseEntry(ownedEntry);
        await awaitProtocolCancellation();
      }
      throw invalidResponse();
    }

    if (ownedEntry !== null && ownedEntry.id !== initial.id) {
      pending.length = 0;
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      await awaitProtocolCancellation();
      throw invalidResponse();
    }

    if (initial.state !== 'running') {
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
    if (ownedEntry === null) bindOwned(initial);
    ledger = {
      sequence: initial.sequence,
      state: initial.state,
      basisPoints: initial.progress.basisPoints,
      phaseRank: -1,
      fraction: null,
    };
    const existingEntry = activeChannels.get(initial.id);
    if (existingEntry !== undefined && existingEntry !== ownedEntry) {
      terminal = true;
      releaseEntry(ownedEntry);
      call(handlers.onProtocolError, invalidResponse());
      throw invalidResponse();
    }
    activeChannels.set(initial.id, ownedEntry);
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
    return initial;
  };

  const run = async (rawRequest, rawOptions) => {
    const options = normalizeRunOptions(rawOptions);
    const { signal, onProgress } = options;

    let initial = null;
    let settled = false;
    let cancelRequested = false;
    let cancelPromise = null;
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      resolveTerminal(outcome);
    };
    const cancelStartedJob = () => {
      cancelRequested = true;
      if (initial === null || cancelPromise !== null) return cancelPromise;
      cancelPromise = cancel(initial.id).then((job) => {
        if (job.state === 'cancelled') settle({ error: cancelledOperation() });
        else if (job.state !== 'cancelling') settle({ error: invalidResponse() });
        return job;
      }).catch((error) => {
        settle({ error });
        return null;
      });
      return cancelPromise;
    };
    const handleAbort = () => {
      if (settled) return;
      cancelRequested = true;
      settle({ error: cancelledOperation() });
      cancelStartedJob();
    };

    let listenerRegistrationAttempted = false;
    try {
      if (signal !== undefined) {
        listenerRegistrationAttempted = true;
        try {
          signal.addEventListener('abort', handleAbort, { once: true });
        } catch {
          throw invalidRequest();
        }
      }
      if (signal?.readAborted()) throw cancelledOperation();
      try {
        initial = await start(rawRequest, {
          onProgress,
          onCompleted: (event) => settle({ result: event.result }),
          onCancelled: () => settle({ error: cancelledOperation() }),
          onFailed: (event) => settle({
            error: new MediaPipelineServiceError(event.error.code, event.error.message),
          }),
          onProtocolError: (error) => settle({ error }),
        });
      } catch (error) {
        settle({ error });
      }
      if (initial !== null && cancelRequested) cancelStartedJob();
      if (cancelRequested && cancelPromise !== null) await cancelPromise;
      const outcome = await terminal;
      if (outcome.error) throw outcome.error;
      return outcome.result;
    } finally {
      if (listenerRegistrationAttempted) {
        try {
          signal.removeEventListener('abort', handleAbort);
        } catch {
          // A hostile signal cannot replace or leak the native operation outcome.
        }
      }
    }
  };

  return Object.freeze({ inspect, start, cancel, run });
};

const mediaPipelineService = createNativeMediaPipelineService();

export const inspectMediaPipelineAsset = mediaPipelineService.inspect;
export const runMediaPipeline = mediaPipelineService.run;
