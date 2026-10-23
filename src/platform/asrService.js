import { Channel } from '@tauri-apps/api/core';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import {
  MAX_DURATION_MS,
  MAX_JOB_EVENTS,
  MAX_PENDING_EVENTS,
  cancelledRequest,
  desktopRequired,
  invalidRequest,
  invalidResponse,
  normalizeAsrJobEvent,
  normalizeAsrStartRequest,
  normalizeAsrStatus,
  normalizeHandlers,
  normalizeJobSnapshot,
  normalizeStartOptions,
  progressPhaseRank,
  requireUuidV7,
} from './asrContract';

/**
 * Native-only local-ASR bridge. Media is selected by the privileged desktop session; this module
 * never accepts a file path or raw media payload and has no HTTP or browser-storage fallback.
 */
export const createNativeAsrService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const requireNativeRuntime = () => {
    if (!isNativeRuntime()) throw desktopRequired();
  };

  const getAsrStatus = async () => {
    requireNativeRuntime();
    return normalizeAsrStatus(await invokeCommand('asr_status', {}));
  };

  const cancelAsrJob = async (jobId) => {
    requireNativeRuntime();
    const id = requireUuidV7(jobId);
    const snapshot = normalizeJobSnapshot(await invokeCommand('job_cancel', { id }));
    if (snapshot.id !== id
        || (snapshot.state !== 'cancelling' && snapshot.state !== 'cancelled')) {
      throw invalidResponse();
    }
    return snapshot;
  };

  const startAsrJob = async (request, rawHandlers, rawOptions) => {
    requireNativeRuntime();
    const normalizedRequest = normalizeAsrStartRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const { signal } = normalizeStartOptions(rawOptions);
    if (signal?.aborted) throw cancelledRequest();
    const pendingEvents = [];
    let initial = null;
    let terminal = false;
    let protocolError = null;
    let eventCount = 0;
    let lastPhaseRank = -1;
    let lastFraction = null;
    let abortRequested = signal?.aborted ?? false;
    let abortCancellationIssued = false;
    let abortListenerAttached = false;

    const safelyCall = (handler, argument) => {
      if (typeof handler !== 'function') return;
      const reportHandlerError = (error) => {
        if (typeof handlers.onHandlerError !== 'function') return;
        try {
          const diagnosticResult = handlers.onHandlerError(error);
          if (diagnosticResult && typeof diagnosticResult.catch === 'function') {
            diagnosticResult.catch(() => undefined);
          }
        } catch {
          // Diagnostic callbacks cannot be allowed to break Tauri's Channel callback.
        }
      };
      try {
        const result = handler(argument);
        if (result && typeof result.catch === 'function') result.catch(reportHandlerError);
      } catch (error) {
        reportHandlerError(error);
      }
    };

    const removeAbortListener = () => {
      if (!signal || !abortListenerAttached) return;
      abortListenerAttached = false;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // A foreign AbortSignal implementation cannot compromise job event cleanup.
      }
    };

    const release = () => {
      if (initial !== null) activeChannels.delete(initial.id);
      removeAbortListener();
    };

    const issueCancellation = () => {
      if (abortCancellationIssued || initial === null || terminal) return;
      abortCancellationIssued = true;
      cancelAsrJob(initial.id)
        .then((snapshot) => {
          if (snapshot.state === 'cancelled') {
            terminal = true;
            release();
          }
        })
        .catch((error) => {
          safelyCall(handlers.onCancellationError, error);
        });
    };

    const protocolFailure = (error = invalidResponse()) => {
      if (protocolError !== null || terminal) return;
      protocolError = error;
      pendingEvents.length = 0;
      safelyCall(handlers.onProtocolError, error);
      issueCancellation();
      release();
    };

    function onAbort() {
      abortRequested = true;
      issueCancellation();
    }

    const dispatch = (event) => {
      if (terminal || protocolError !== null) return;
      if (eventCount >= MAX_JOB_EVENTS) {
        protocolFailure();
        return;
      }
      eventCount += 1;

      const eventJobId = event.event === 'progress' ? event.jobId : event.job?.id;
      if (eventJobId !== undefined && eventJobId !== null && eventJobId !== initial.id) {
        protocolFailure();
        return;
      }
      if (event.event !== 'progress'
          && event.job !== null
          && event.job.sequence < initial.sequence) {
        protocolFailure();
        return;
      }

      if (event.event === 'progress') {
        const phaseRank = progressPhaseRank.get(event.phase);
        if (phaseRank < lastPhaseRank
            || (phaseRank === lastPhaseRank
              && event.fraction !== null
              && lastFraction !== null
              && event.fraction < lastFraction)) {
          protocolFailure();
          return;
        }
        if (phaseRank !== lastPhaseRank) lastFraction = null;
        lastPhaseRank = phaseRank;
        if (event.fraction !== null) lastFraction = event.fraction;
      } else if (event.event === 'completed') {
        const expectedOffset = normalizedRequest.range?.startMs ?? 0;
        const maximumDuration = normalizedRequest.range === undefined
          ? MAX_DURATION_MS
          : normalizedRequest.range.endMs - normalizedRequest.range.startMs;
        if (event.transcription.engine !== normalizedRequest.engine
            || event.timelineOffsetMs !== expectedOffset
            || event.transcription.durationMs > maximumDuration) {
          protocolFailure();
          return;
        }
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
        event = normalizeAsrJobEvent(rawEvent);
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
      snapshot = normalizeJobSnapshot(await invokeCommand('asr_start', {
        request: normalizedRequest,
        onEvent: channel,
      }));
      initial = snapshot;
      if (snapshot.state !== 'running'
          || snapshot.progress.basisPoints !== 0
          || snapshot.sequence !== 1) {
        protocolFailure();
        throw protocolError;
      }
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

  return Object.freeze({ getAsrStatus, startAsrJob, cancelAsrJob });
};

const asrService = createNativeAsrService();

export const getAsrStatus = asrService.getAsrStatus;
export const startAsrJob = asrService.startAsrJob;
