import { useState, useEffect, useCallback, useRef } from 'react';
import { getAsrStatus } from '../platform/asrService';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { MANAGED_SPEECH_ENGINE_BINDINGS } from '../platform/managedEngineCatalog';
import { getSpeechStatus } from '../platform/speechService';

const POLL_MS = 5000;

export const mapNativeAsrEngines = (status) => Object.fromEntries(
  status.engines.map((engine) => [engine.id, {
    id: engine.id,
    label: engine.label,
    installed: engine.installed,
    running: engine.ready,
    state: engine.ready
      ? 'ready'
      : engine.installed
        ? 'installed-stopped'
        : 'not-installed',
    warm: engine.warm,
    runtime: engine.runtime,
    supportsForcedLanguage: engine.supportsForcedLanguage,
    requiresAligner: engine.requiresAligner,
    managedByElectron: false,
  }])
);

export const mapNativeSpeechEngines = (status) => {
  const backendById = new Map(status.backends.map((backend) => [backend.backend, backend]));
  return Object.fromEntries(MANAGED_SPEECH_ENGINE_BINDINGS.map((binding) => {
    const backend = backendById.get(binding.runtimeBackend);
    if (!backend) throw new Error('The native speech status is incomplete');
    return [binding.engineId, {
      id: binding.engineId,
      label: binding.label,
      installed: backend.installed,
      running: backend.warm,
      state: backend.ready
        ? 'ready'
        : backend.installed
          ? 'installed-stopped'
          : 'not-installed',
      warm: backend.warm,
      runtime: 'native-speech',
      managedByElectron: false,
    }];
  }));
};

/**
 * Unified per-engine availability from the native ASR catalog. Browser-only inspection exposes no
 * installable engines: engine state is privileged desktop state and has no network fallback.
 *
 * Returns { engines, loading, refresh, isReady(id), isInstalled(id) } where each engine is
 * { id, label, port, installed, running, state: 'not-installed'|'installed-stopped'|'ready' }.
 */
export const useEngineStatus = ({ poll = true } = {}) => {
  const [engines, setEngines] = useState({});
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = sequence;
    try {
      if (!isDesktopRuntime()) {
        if (mountedRef.current && sequence === refreshSequenceRef.current) setEngines({});
        return;
      }
      const [asrResult, speechResult] = await Promise.allSettled([
        getAsrStatus(),
        getSpeechStatus(),
      ]);
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return;
      if (asrResult.status === 'rejected' && speechResult.status === 'rejected') return;
      const asrEngines = asrResult.status === 'fulfilled'
        ? mapNativeAsrEngines(asrResult.value)
        : null;
      const speechEngines = speechResult.status === 'fulfilled'
        ? mapNativeSpeechEngines(speechResult.value)
        : null;
      setEngines((current) => ({
        ...current,
        ...(asrEngines || {}),
        ...(speechEngines || {}),
      }));
    } catch {
      // Preserve the last validated snapshot if either mapped response violates its contract.
    } finally {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    if (!poll) return () => { mountedRef.current = false; };
    const id = setInterval(refresh, POLL_MS);
    return () => { mountedRef.current = false; clearInterval(id); };
  }, [refresh, poll]);

  const isReady = useCallback((id) => engines[id]?.state === 'ready', [engines]);
  const isInstalled = useCallback((id) => !!engines[id]?.installed, [engines]);

  return { engines, loading, refresh, isReady, isInstalled };
};

export default useEngineStatus;
