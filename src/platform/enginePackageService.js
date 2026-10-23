import { Channel } from '@tauri-apps/api/core';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import {
  cancelledRequest,
  EnginePackageServiceError,
  invalidRequest,
  invalidResponse,
  isUuidV7,
  MAX_JOB_EVENTS,
  MAX_PENDING_EVENTS,
  normalizeEnginePackageEvent,
  normalizeEnginePackageJob,
  normalizeEnginePackagesStatus,
  normalizeHandlers,
  normalizeOptions,
  requireDesktop,
  requireEngine,
} from './enginePackageContract';

export {
  ENGINE_PACKAGE_ENGINE_IDS,
  EnginePackageServiceError,
  normalizeEnginePackageEvent,
  normalizeEnginePackageJob,
  normalizeEnginePackagesStatus,
} from './enginePackageContract';

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
