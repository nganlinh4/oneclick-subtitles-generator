import { abortedFailure } from './nativeUrlDownloadContract';
import {
  assertListenerLive,
  attachAbortBinding,
  detachAbortBinding,
  replayListenerCallback,
} from './nativeUrlDownloadSubscriber';

/**
 * The subscriber set of one shared URL-download operation: joining, settling, pruning stale
 * subscribers and publishing to the live ones. Whenever the set empties, the adapter-owned
 * `requestOperationCancel` stops the native job that nobody is waiting for any more.
 */
export const createOperationListeners = (requestOperationCancel) => {
  const settleListener = (operation, listener, outcome, value) => {
    if (listener.settled) return;
    listener.settled = true;
    listener.settlementError = outcome === 'reject' ? value : null;
    operation.listeners.delete(listener);
    detachAbortBinding(listener);
    if (outcome === 'resolve') listener.resolve(value);
    else listener.reject(value);
  };

  const settleAll = async (operation, outcome, value) => {
    for (const listener of [...operation.listeners]) {
      try {
        await assertListenerLive(listener);
        settleListener(operation, listener, outcome, value);
      } catch (error) {
        settleListener(operation, listener, 'reject', error);
      }
    }
  };

  const subscribe = (
    operation,
    {
      admitActivation,
      onStarted,
      onProgress,
      onSubtitle,
      publishActivation,
      rollbackActivation,
      signalBinding,
      validateOwnership,
    }
  ) => {
    let listener;
    const promise = new Promise((resolve, reject) => {
      listener = {
        aborted: false,
        admitActivation,
        handleAbort: null,
        onProgress,
        onStarted,
        onSubtitle,
        publishActivation,
        reject,
        resolve,
        rollbackActivation,
        settlementError: null,
        settled: false,
        signalAttached: false,
        signalBinding,
        validateOwnership,
      };
      listener.handleAbort = () => {
        listener.aborted = true;
        settleListener(operation, listener, 'reject', abortedFailure());
        if (operation.listeners.size === 0) {
          requestOperationCancel(operation);
        }
      };
      operation.listeners.add(listener);
      if (operation.jobId === null && operation.registrationStarted) {
        operation.cancelRequested = false;
      }
      if (signalBinding !== null) {
        try {
          attachAbortBinding(listener, signalBinding, listener.handleAbort);
        } catch (error) {
          settleListener(operation, listener, 'reject', error);
          return;
        }
        // An already-aborted signal settles the subscriber synchronously during attachment.
        if (listener.settled) {
          detachAbortBinding(listener);
          return;
        }
      }
      Promise.resolve().then(async () => {
        if (operation.jobId !== null) {
          await replayListenerCallback(listener, 'onStarted', operation.jobId);
        }
        if (operation.percent !== null) {
          await replayListenerCallback(listener, 'onProgress', operation.percent);
        }
        if (operation.subtitle !== null) {
          await replayListenerCallback(listener, 'onSubtitle', operation.subtitle);
        }
      }).catch((error) => {
        settleListener(operation, listener, 'reject', error);
        if (operation.listeners.size === 0) requestOperationCancel(operation);
      });
      });
    promise.catch(() => undefined);
    return Object.freeze({
      listener,
      promise,
      registered: !listener.settled,
    });
  };

  const revalidateListeners = async (operation, { cancelIfEmpty = false } = {}) => {
    for (const listener of [...operation.listeners]) {
      try {
        await assertListenerLive(listener);
      } catch (error) {
        settleListener(operation, listener, 'reject', error);
      }
    }
    if (cancelIfEmpty && operation.listeners.size === 0) requestOperationCancel(operation);
    return operation.listeners.size > 0;
  };

  const publishToLiveListeners = async (operation, callbackName, value) => {
    if (!await revalidateListeners(operation, { cancelIfEmpty: true })) return false;
    for (const listener of [...operation.listeners]) {
      try {
        await replayListenerCallback(listener, callbackName, value);
      } catch (error) {
        settleListener(operation, listener, 'reject', error);
      }
    }
    if (operation.listeners.size === 0) {
      requestOperationCancel(operation);
      return false;
    }
    return true;
  };

  return Object.freeze({
    publishToLiveListeners,
    revalidateListeners,
    settleAll,
    settleListener,
    subscribe,
  });
};
