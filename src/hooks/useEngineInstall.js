import { useState, useCallback, useRef, useEffect } from 'react';
import i18n from '../i18n/i18n';
import {
  cancelManagedEnginePackageJob,
  getManagedEnginePackageStatus,
  installManagedEnginePackage,
  removeManagedEnginePackage,
  startManagedEngineRuntime,
  stopManagedEngineRuntime,
} from '../platform/managedEngineService';

/**
 * Drives on-demand install + start/stop of a single heavy engine.
 *
 * Installation runs outside the WebView in the native package manager. On mount this hook
 * reconnects to durable progress and resumes polling, so navigating away or closing the view does
 * not stop the operation. The typed service fails closed when inspected outside Tauri.
 */
export const useEngineInstall = (id, { reconnect = true, onStatusChanged } = {}) => {
  const [installing, setInstalling] = useState(false);
  const [percent, setPercent] = useState(0);
  const [log, setLog] = useState([]);
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);
  const nativeAbortRef = useRef(null);
  const nativeJobIdRef = useRef(null);
  const nativeGenerationRef = useRef(0);
  const observedOperationRef = useRef(false);
  const pollFailuresRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // Read the native package manager's current progress. Returns whether any operation is running.
  const readProgress = useCallback(async () => {
    try {
      const generation = nativeGenerationRef.current;
      const engine = await getManagedEnginePackageStatus(id);
      const operation = engine.operation ?? null;
      pollFailuresRef.current = 0;
      const packageRunning = operation !== null
        && (operation.action === 'install' || operation.action === 'update');
      if (generation !== nativeGenerationRef.current) return operation !== null;
      if (operation) observedOperationRef.current = true;
      else if (observedOperationRef.current) {
        observedOperationRef.current = false;
        onStatusChanged?.();
      }
      nativeJobIdRef.current = operation?.job.id ?? null;
      if (mountedRef.current) {
        setPercent(packageRunning ? operation.basisPoints / 100 : 0);
        setLog([]);
        setOperation(operation);
        setInstalling(packageRunning);
      }
      return operation !== null;
    } catch (e) {
      pollFailuresRef.current += 1;
      const operationExpected = observedOperationRef.current || nativeJobIdRef.current !== null;
      if (operationExpected && pollFailuresRef.current < 20) return true;
      if (operationExpected && mountedRef.current) {
        setError(i18n.t(
          'engines.error.statusLost',
          'Install status could not be refreshed. Retry status; the native job was not abandoned.'
        ));
        setInstalling(false);
        setOperation(null);
      }
      return false;
    }
  }, [id, onStatusChanged]);

  const ensurePolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const running = await readProgress();
      if (!running) stopPolling();
    }, 1500);
  }, [readProgress, stopPolling]);

  // On mount, reconnect to any in-flight server-side install (survives reload / navigation).
  useEffect(() => {
    mountedRef.current = true;
    if (!reconnect) return () => { mountedRef.current = false; stopPolling(); };
    (async () => {
      if (await readProgress()) ensurePolling();
    })();
    return () => { mountedRef.current = false; stopPolling(); };
  }, [readProgress, ensurePolling, reconnect, stopPolling]);

  const install = useCallback(async () => {
    setError(null); setInstalling(true); setPercent(0); setLog([]); setOperation(null);
    nativeGenerationRef.current += 1;
    const controller = new AbortController();
    nativeAbortRef.current = controller;
    let settled = false;
    const finish = () => {
      settled = true;
      nativeGenerationRef.current += 1;
      nativeAbortRef.current = null;
      nativeJobIdRef.current = null;
      if (mountedRef.current) setInstalling(false);
      if (mountedRef.current) setOperation(null);
      onStatusChanged?.();
    };
    try {
      const snapshot = await installManagedEnginePackage(id, {
        onProgress: ({ operation }) => {
          if (!mountedRef.current) return;
          setInstalling(true);
          setOperation(operation);
          setPercent(operation.basisPoints / 100);
        },
        onCompleted: finish,
        onCancelled: finish,
        onFailed: (event) => {
          if (mountedRef.current) setError(event.error.message);
          finish();
        },
        onProtocolError: (protocolError) => {
          if (mountedRef.current) setError(protocolError.message);
          finish();
        },
      }, { signal: controller.signal });
      if (!settled) nativeJobIdRef.current = snapshot.id;
      ensurePolling();
    } catch (e) {
      nativeAbortRef.current = null;
      nativeJobIdRef.current = null;
      if (mountedRef.current) {
        setError(e.message || i18n.t('engines.error.installFailed', 'Install failed to start'));
        setInstalling(false);
      }
    }
  }, [id, ensurePolling, onStatusChanged]);

  // Cancel an in-flight (or reconnected) native install.
  const cancel = useCallback((recoveredJobId = null) => {
    if (nativeAbortRef.current) {
      nativeAbortRef.current.abort();
      return Promise.resolve();
    }
    const activeJobId = recoveredJobId || nativeJobIdRef.current;
    if (activeJobId) {
      return cancelManagedEnginePackageJob(id, activeJobId).catch(() => {});
    }
    return Promise.resolve();
  }, [id]);

  const start = useCallback(async () => {
    setError(null);
    try {
      return await startManagedEngineRuntime(id);
    } catch (e) {
      setError(e.message || i18n.t('engines.error.startFailed', 'Engine failed to start'));
      throw e;
    }
  }, [id]);

  const stop = useCallback(async () => {
    setError(null);
    try {
      return await stopManagedEngineRuntime(id);
    } catch (e) {
      setError(e.message || i18n.t('engines.error.stopFailed', 'Engine failed to stop'));
      throw e;
    }
  }, [id]);

  const uninstall = useCallback(async () => {
    setError(null);
    try {
      return await new Promise((resolve, reject) => {
        removeManagedEnginePackage(id, {
          onCompleted: resolve,
          onCancelled: resolve,
          onFailed: (event) => reject(new Error(event.error.message)),
          onProtocolError: reject,
        }).catch(reject);
      });
    } catch (e) {
      setError(e.message || i18n.t('engines.error.uninstallFailed', 'Uninstall failed'));
      throw e;
    }
  }, [id]);

  return {
    install, cancel, start, stop, uninstall, installing, percent, log, operation, error,
  };
};

export default useEngineInstall;
