// Abort-signal observation for native renders: one guarded listener per caller signal, shared by
// the start/run/wait layers so a hostile signal is touched exactly once.
import { cancelled, invalidRequest } from './renderErrors';
import { isRecord } from './renderValidation';

export const internalAbortMonitors = new WeakMap();

export const createAbortMonitor = (signal) => {
  if (signal === null) return null;
  let initiallyAborted;
  let addEventListener;
  let removeEventListener;
  try {
    if (!isRecord(signal)) throw invalidRequest();
    initiallyAborted = signal.aborted;
    addEventListener = signal.addEventListener;
    removeEventListener = signal.removeEventListener;
  } catch {
    throw invalidRequest();
  }
  if (typeof initiallyAborted !== 'boolean'
      || typeof addEventListener !== 'function'
      || typeof removeEventListener !== 'function') {
    throw invalidRequest();
  }

  let aborted = initiallyAborted;
  let attached = false;
  let disposed = false;
  const listeners = new Set();
  const notify = () => {
    if (disposed || aborted) return;
    aborted = true;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // An internal cancellation observer cannot break the other owners.
      }
    }
  };
  const detachUpstream = () => {
    if (!attached) return;
    attached = false;
    try {
      removeEventListener.call(signal, 'abort', notify);
    } catch {
      // A hostile cleanup method cannot escape into terminal delivery.
    }
  };

  if (!aborted) {
    let registrationFailed = false;
    try {
      addEventListener.call(signal, 'abort', notify, { once: true });
      attached = true;
    } catch {
      registrationFailed = true;
      // The method may have attached before throwing, so attempt guarded cleanup.
      attached = true;
      detachUpstream();
      if (!aborted) {
        disposed = true;
        throw invalidRequest();
      }
    }
    if (!registrationFailed) {
      let observedAfterRegistration;
      try {
        observedAfterRegistration = signal.aborted;
      } catch {
        detachUpstream();
        disposed = true;
        throw invalidRequest();
      }
      if (typeof observedAfterRegistration !== 'boolean') {
        detachUpstream();
        disposed = true;
        throw invalidRequest();
      }
      if (observedAfterRegistration) notify();
    }
  }

  return Object.freeze({
    isAborted: () => aborted,
    listen: (listener) => {
      if (typeof listener !== 'function') throw invalidRequest();
      if (aborted) {
        try {
          listener();
        } catch {
          // Cancellation remains authoritative.
        }
        return () => {};
      }
      if (disposed) return () => {};
      listeners.add(listener);
      let listening = true;
      return () => {
        if (!listening) return;
        listening = false;
        listeners.delete(listener);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      detachUpstream();
    },
  });
};

export const abortableDelay = (milliseconds, abortMonitor) => new Promise((resolve, reject) => {
  if (abortMonitor?.isAborted()) {
    reject(cancelled());
    return;
  }
  let timer = null;
  let settled = false;
  let stopListening = () => {};
  const cleanup = () => {
    try {
      stopListening();
    } catch {
      // The internal observer is best-effort cleanup only.
    }
  };
  const onAbort = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    cleanup();
    reject(cancelled());
  };
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  }, milliseconds);
  stopListening = abortMonitor?.listen(onAbort) ?? stopListening;
  if (settled && timer !== null) clearTimeout(timer);
});
