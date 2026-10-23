// Channel ownership for one native speech job: buffers events until the start reply arrives, checks
// every event against the requested segments and the runtime lifecycle epoch, and cancels on drift.
import { hasOnlyKeys, isRecord } from './plainDataRecord';
import {
  MAX_JOB_EVENTS,
  MAX_PENDING_EVENTS,
  cancelledRequest,
  invalidRequest,
  invalidResponse,
  runtimeStopped,
} from './speechContract';
import { normalizeJobSnapshot, normalizeSpeechJobEvent } from './speechResponses';

const handlerKeys = new Set([
  'onEvent',
  'onProgress',
  'onSegmentCompleted',
  'onSegmentFailed',
  'onCompleted',
  'onCancelled',
  'onFailed',
  'onProtocolError',
  'onHandlerError',
  'onCancellationError',
]);
const startOptionKeys = new Set(['signal']);

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!hasOnlyKeys(handlers, handlerKeys)) throw invalidRequest();
  for (const handler of Object.values(handlers)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(handlers).filter(([, handler]) => handler !== undefined)
  ));
};

const normalizeStartOptions = (options) => {
  if (options === undefined) return Object.freeze({ signal: null });
  if (!hasOnlyKeys(options, startOptionKeys)) throw invalidRequest();
  const signal = options.signal;
  if (signal === undefined || signal === null) return Object.freeze({ signal: null });
  if (!isRecord(signal)
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function') {
    throw invalidRequest();
  }
  return Object.freeze({ signal });
};

export const createSpeechJobStarter = ({
  invokeCommand,
  ChannelConstructor,
  lifecycleState,
  requireNativeRuntime,
  cancelSpeechJob,
}) => {
  const activeChannels = new Map();

  return async ({
    command,
    request,
    ownership,
    expectedSegmentIds,
    handlers: rawHandlers,
    options: rawOptions,
  }) => {
    requireNativeRuntime();
    const handlers = normalizeHandlers(rawHandlers);
    const { signal } = normalizeStartOptions(rawOptions);
    if (signal?.aborted) throw cancelledRequest();
    const lifecycleMatches = () => {
      const current = lifecycleState.getSnapshot(ownership.backend);
      return current !== null
        && current.epoch === ownership.epoch
        && current.enabled
        && current.warm;
    };
    if (!lifecycleMatches()) throw runtimeStopped();

    const expectedIds = new Set(expectedSegmentIds);
    const pendingEvents = [];
    const terminalResults = new Map();
    const segmentEventIds = new Set();
    let initial = null;
    let terminal = false;
    let protocolError = null;
    let eventCount = 0;
    let abortRequested = false;
    let cancellationIssued = false;
    let abortListenerAttached = false;
    let lifecycleUnsubscribe = null;
    let ownershipError = null;

    const safelyCall = (handler, argument) => {
      if (typeof handler !== 'function') return;
      const report = (error) => {
        if (typeof handlers.onHandlerError !== 'function') return;
        try {
          const result = handlers.onHandlerError(error);
          if (result && typeof result.catch === 'function') result.catch(() => undefined);
        } catch {
          // Diagnostic callbacks cannot break native channel processing.
        }
      };
      try {
        const result = handler(argument);
        if (result && typeof result.catch === 'function') result.catch(report);
      } catch (error) {
        report(error);
      }
    };

    const removeAbortListener = () => {
      if (!signal || !abortListenerAttached) return;
      abortListenerAttached = false;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Foreign AbortSignal implementations cannot compromise cleanup.
      }
    };

    const release = () => {
      if (initial !== null) activeChannels.delete(initial.id);
      removeAbortListener();
      if (lifecycleUnsubscribe !== null) {
        const unsubscribe = lifecycleUnsubscribe;
        lifecycleUnsubscribe = null;
        unsubscribe();
      }
    };

    const issueCancellation = () => {
      if (cancellationIssued || initial === null || terminal) return;
      cancellationIssued = true;
      cancelSpeechJob(initial.id).catch((error) => {
        safelyCall(handlers.onCancellationError, error);
      });
    };

    const failProtocol = (error = invalidResponse()) => {
      if (protocolError !== null || terminal) return;
      protocolError = error;
      pendingEvents.length = 0;
      safelyCall(handlers.onProtocolError, error);
      issueCancellation();
      release();
    };

    const failOwnership = () => {
      if (ownershipError !== null || protocolError !== null || terminal) return;
      ownershipError = runtimeStopped();
      pendingEvents.length = 0;
      safelyCall(handlers.onProtocolError, ownershipError);
      issueCancellation();
      release();
    };

    function onAbort() {
      abortRequested = true;
      issueCancellation();
    }

    const validateResultIdentity = (result) => {
      if (!expectedIds.has(result.segmentId)) throw invalidResponse();
    };

    const dispatch = (event) => {
      if (terminal || protocolError !== null || ownershipError !== null) return;
      if (!lifecycleMatches()) {
        failOwnership();
        return;
      }
      if (eventCount >= MAX_JOB_EVENTS) {
        failProtocol();
        return;
      }
      eventCount += 1;
      const eventJobId = event.event === 'progress'
        || event.event === 'segmentCompleted'
        || event.event === 'segmentFailed'
        ? event.jobId
        : event.job?.id;
      if (eventJobId !== undefined && eventJobId !== null && eventJobId !== initial.id) {
        failProtocol();
        return;
      }

      try {
        if (event.event === 'progress') {
          if (event.total !== expectedIds.size
              || (event.segmentId !== null && !expectedIds.has(event.segmentId))) {
            throw invalidResponse();
          }
        } else if (event.event === 'segmentCompleted' || event.event === 'segmentFailed') {
          validateResultIdentity(event.result);
          if (event.total !== expectedIds.size
              || segmentEventIds.has(event.result.segmentId)) {
            throw invalidResponse();
          }
          segmentEventIds.add(event.result.segmentId);
          terminalResults.set(event.result.segmentId, event.result);
        } else {
          const terminalIds = new Set();
          for (const result of event.results) {
            validateResultIdentity(result);
            terminalIds.add(result.segmentId);
            const streamed = terminalResults.get(result.segmentId);
            if (streamed !== undefined
                && JSON.stringify(streamed) !== JSON.stringify(result)) {
              throw invalidResponse();
            }
          }
          for (const segmentId of terminalResults.keys()) {
            if (!terminalIds.has(segmentId)) throw invalidResponse();
          }
          if (event.event === 'completed'
              && event.results.length !== expectedIds.size) {
            throw invalidResponse();
          }
        }
      } catch (error) {
        failProtocol(error);
        return;
      }

      safelyCall(handlers.onEvent, event);
      if (!lifecycleMatches()) {
        failOwnership();
        return;
      }
      if (event.event === 'progress') safelyCall(handlers.onProgress, event);
      if (event.event === 'segmentCompleted') safelyCall(handlers.onSegmentCompleted, event);
      if (event.event === 'segmentFailed') safelyCall(handlers.onSegmentFailed, event);
      if (event.event === 'completed') safelyCall(handlers.onCompleted, event);
      if (event.event === 'cancelled') safelyCall(handlers.onCancelled, event);
      if (event.event === 'failed') safelyCall(handlers.onFailed, event);
      if (event.event === 'completed'
          || event.event === 'cancelled'
          || event.event === 'failed') {
        terminal = true;
        release();
      }
    };

    let channel;
    try {
      channel = new ChannelConstructor();
    } catch {
      throw invalidRequest();
    }
    if (!isRecord(channel)) throw invalidRequest();

    const unsubscribe = lifecycleState.subscribe((status) => {
      if (status.backend === ownership.backend && !lifecycleMatches()) failOwnership();
    });
    lifecycleUnsubscribe = unsubscribe;
    if (ownershipError !== null) {
      release();
      throw ownershipError;
    }

    if (signal) {
      try {
        signal.addEventListener('abort', onAbort, { once: true });
        abortListenerAttached = true;
      } catch {
        throw invalidRequest();
      }
    }

    channel.onmessage = (rawEvent) => {
      if (terminal || protocolError !== null || ownershipError !== null) return;
      if (!lifecycleMatches()) {
        failOwnership();
        return;
      }
      let event;
      try {
        event = normalizeSpeechJobEvent(rawEvent);
      } catch (error) {
        failProtocol(error);
        return;
      }
      if (initial === null) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          failProtocol();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      dispatch(event);
    };

    let snapshot;
    try {
      snapshot = normalizeJobSnapshot(await invokeCommand(command, { request, onEvent: channel }));
      initial = snapshot;
      if (ownershipError !== null || !lifecycleMatches()) {
        if (ownershipError === null) failOwnership();
        issueCancellation();
        release();
        throw ownershipError;
      }
      if (snapshot.state !== 'running'
          || snapshot.progress.basisPoints !== 0
          || snapshot.sequence !== 1) {
        failProtocol();
        throw protocolError;
      }
    } catch (error) {
      pendingEvents.length = 0;
      release();
      throw ownershipError || error;
    }

    if (ownershipError !== null) {
      issueCancellation();
      release();
      throw ownershipError;
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
};
