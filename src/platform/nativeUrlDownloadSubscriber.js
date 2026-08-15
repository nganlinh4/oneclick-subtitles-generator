import { abortedFailure, fixedFailure } from './nativeUrlDownloadContract';

/**
 * Subscriber liveness for native URL downloads. Every subscriber owns its own abort signal and
 * ownership validator, so one stale subscriber can fail without disturbing the operation it shares
 * with live ones. Liveness is re-asserted immediately before and after any awaited callback.
 */

const checkListenerState = (listener) => {
  if (listener.settled) {
    throw listener.settlementError ?? abortedFailure();
  }
  if (listener.aborted) throw abortedFailure();
};

export const assertListenerLive = async (listener) => {
  checkListenerState(listener);
  if (typeof listener.validateOwnership === 'function') {
    await Promise.resolve(listener.validateOwnership());
  }
  checkListenerState(listener);
};

export const replayListenerCallback = async (listener, callbackName, value) => {
  await assertListenerLive(listener);
  const callback = listener[callbackName];
  if (typeof callback === 'function') {
    try {
      await Promise.resolve(callback(value));
    } catch {
      throw fixedFailure('downloadCallbackFailed');
    }
  }
  await assertListenerLive(listener);
};

/**
 * Attach the subscriber's abort handler. A hostile signal may throw from `addEventListener`, return
 * a non-boolean `aborted`, or abort synchronously; registration is rolled back in every case before
 * the fixed failure is raised.
 */
export const attachAbortBinding = (listener, signalBinding, onAbort) => {
  if (signalBinding === null) return;
  try {
    signalBinding.add.call(signalBinding.target, 'abort', onAbort, { once: true });
    listener.signalAttached = true;
    const isAborted = Reflect.get(signalBinding.target, 'aborted');
    if (typeof isAborted !== 'boolean') throw fixedFailure('invalidDownloadRequest');
    if (isAborted) onAbort();
  } catch {
    if (listener.signalAttached) listener.signalAttached = false;
    try {
      signalBinding.remove.call(signalBinding.target, 'abort', onAbort);
    } catch {
      // Registration rollback remains authoritative.
    }
    throw fixedFailure('invalidDownloadRequest');
  }
};

/** Detach exactly once. Cleanup failure can never replace an already-decided outcome. */
export const detachAbortBinding = (listener) => {
  if (!listener.signalAttached) return;
  listener.signalAttached = false;
  try {
    listener.signalBinding.remove.call(
      listener.signalBinding.target,
      'abort',
      listener.handleAbort
    );
  } catch {
    // The subscriber's outcome is already authoritative.
  }
};
