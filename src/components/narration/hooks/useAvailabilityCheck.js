import { useEffect, useState } from 'react';
import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import { subscribeSpeechLifecycle } from '../../../platform/speechService';
import {
  initializeCredentialState,
  subscribeCredentialState,
} from '../../../platform/credentialStateController';

const POLL_INTERVAL_MS = 5_000;
const availabilityBackends = Object.freeze([
  Object.freeze({ key: 'f5Status', backend: 'f5Tts' }),
  Object.freeze({ key: 'chatterboxStatus', backend: 'chatterbox' }),
  Object.freeze({ key: 'edgeTtsStatus', backend: 'edgeTts' }),
  Object.freeze({ key: 'gttsStatus', backend: 'gtts' }),
  Object.freeze({ key: 'geminiTtsStatus', backend: 'geminiTts' }),
]);

const unavailable = (reason) => Object.freeze({
  available: false,
  reason,
  message: 'SERVICE_UNAVAILABLE',
});
const available = Object.freeze({ available: true, reason: 'ready' });
const cold = Object.freeze({ available: true, reason: 'cold' });
const installable = Object.freeze({ available: true, reason: 'installable' });
const checkingCredential = Object.freeze({
  checked: false,
  available: false,
  reason: 'checking',
});

export const unavailableNativeNarrationAvailability = () => Object.freeze(
  Object.fromEntries(availabilityBackends.map(({ key }) => [key, unavailable('unavailable')]))
);
export const managedNativeNarrationAvailability = () => Object.freeze(
  Object.fromEntries(availabilityBackends.map(({ key }) => [key, installable]))
);

const findBackend = (status, backend) => (
  status.backends.find((candidate) => candidate.backend === backend)
);
const isReadyAndWarm = (snapshot) => (
  snapshot?.installed === true
  && snapshot.enabled === true
  && snapshot.ready === true
  && snapshot.warm === true
);
const capability = (snapshot) => {
  if (isReadyAndWarm(snapshot)) return available;
  if (snapshot?.installed) return cold;
  // Every binding here comes from the compile-time managed speech catalog. The explicit Generate
  // action checks delivery health; transient package inspection must never lock the method UI.
  return installable;
};

export const checkNativeNarrationAvailability = async (
  adapter = nativeNarrationAdapter,
  { probeInstalled = false } = {}
) => {
  const initialStatus = await adapter.getStatus();
  if (!probeInstalled) {
    return Object.freeze(Object.fromEntries(availabilityBackends.map(({ key, backend }) => {
      const snapshot = findBackend(initialStatus, backend);
      return [key, capability(snapshot)];
    })));
  }

  const probeOutcomes = new Map();
  await Promise.all(availabilityBackends.map(async ({ backend }) => {
    const snapshot = findBackend(initialStatus, backend);
    if (!snapshot?.installed) {
      probeOutcomes.set(backend, 'not-installed');
      return;
    }
    try {
      await adapter.probe(backend);
      probeOutcomes.set(backend, 'probed');
    } catch {
      probeOutcomes.set(backend, 'probe-failed');
    }
  }));

  // Re-read only when probing could have changed a lifecycle. Package capability remains usable
  // even when no worker was started.
  const verifiedStatus = [...probeOutcomes.values()].includes('probed')
    ? await adapter.getStatus()
    : initialStatus;
  const entries = availabilityBackends.map(({ key, backend }) => {
    const snapshot = findBackend(verifiedStatus, backend);
    return [key, capability(snapshot)];
  });
  return Object.freeze(Object.fromEntries(entries));
};

export const getGeminiCredentialAvailability = (snapshot) => {
  if (snapshot?.initialized !== true) return checkingCredential;
  if (snapshot.store !== 'available') {
    return Object.freeze({ checked: true, available: false, reason: 'store-unavailable' });
  }
  const availableIds = Array.isArray(snapshot.gemini?.availableCredentialIds)
    ? snapshot.gemini.availableCredentialIds
    : [];
  const activeId = snapshot.gemini?.activeCredentialId;
  if (typeof activeId === 'string' && availableIds.includes(activeId)) {
    return Object.freeze({ checked: true, available: true, reason: 'ready' });
  }
  const hasGeminiCredential = Array.isArray(snapshot.credentials)
    && snapshot.credentials.some(({ purpose }) => purpose === 'geminiApiKey');
  return Object.freeze({
    checked: true,
    available: false,
    reason: hasGeminiCredential ? 'unusable' : 'missing',
  });
};

/**
 * Checks native narration readiness and combines Gemini worker state with safe credential metadata.
 * Native probing is mount-scoped; changing the selected method only changes presentation.
 */
const useAvailabilityCheck = ({
  setIsAvailable,
  setIsGeminiAvailable,
  setIsChatterboxAvailable,
  setIsEdgeTTSAvailable,
  setIsGTTSAvailable,
  setIsCheckingAvailability,
}) => {
  const [nativeAvailability, setNativeAvailability] = useState(() => (
    isDesktopRuntime()
      ? managedNativeNarrationAvailability()
      : unavailableNativeNarrationAvailability()
  ));
  const [nativeChecking, setNativeChecking] = useState(true);
  const [credentialAvailability, setCredentialAvailability] = useState(checkingCredential);

  useEffect(() => {
    let disposed = false;
    let pollTimer = null;
    let lifecycleRevision = 0;

    const unsubscribeLifecycle = subscribeSpeechLifecycle((snapshot) => {
      lifecycleRevision += 1;
      const binding = availabilityBackends.find(({ backend }) => backend === snapshot.backend);
      if (!disposed && binding) {
        setNativeAvailability((current) => Object.freeze({
          ...current,
          [binding.key]: snapshot.installed
            ? (isReadyAndWarm(snapshot) ? available : cold)
            : current[binding.key],
        }));
      }
    });

    const checkAvailability = async ({ probeInstalled }) => {
      const requestRevision = lifecycleRevision;
      let next;
      try {
        next = isDesktopRuntime()
          ? await checkNativeNarrationAvailability(
            nativeNarrationAdapter,
            { probeInstalled }
          )
          : unavailableNativeNarrationAvailability();
      } catch (error) {
        console.error('Error checking service availability:', error);
        next = isDesktopRuntime()
          ? managedNativeNarrationAvailability()
          : unavailableNativeNarrationAvailability();
      }
      if (!disposed && lifecycleRevision === requestRevision) setNativeAvailability(next);
    };

    const schedulePoll = () => {
      if (disposed) return;
      pollTimer = setTimeout(async () => {
        await checkAvailability({ probeInstalled: false });
        schedulePoll();
      }, POLL_INTERVAL_MS);
    };
    // Passive inspection never starts a worker. Generation owns on-demand install/start.
    checkAvailability({ probeInstalled: false }).finally(() => {
      if (!disposed) setNativeChecking(false);
      schedulePoll();
    });
    return () => {
      disposed = true;
      unsubscribeLifecycle();
      if (pollTimer !== null) clearTimeout(pollTimer);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    if (!isDesktopRuntime()) {
      setCredentialAvailability(Object.freeze({
        checked: true,
        available: false,
        reason: 'unsupported',
      }));
      return undefined;
    }
    const applySnapshot = (snapshot) => {
      if (!disposed) setCredentialAvailability(getGeminiCredentialAvailability(snapshot));
    };
    const unsubscribe = subscribeCredentialState(applySnapshot);
    initializeCredentialState().then(applySnapshot).catch(() => {
      if (!disposed) setCredentialAvailability(Object.freeze({
        checked: true,
        available: false,
        reason: 'unavailable',
      }));
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const geminiBackendAvailable = nativeAvailability.geminiTtsStatus.available;
  const geminiAvailable = geminiBackendAvailable && credentialAvailability.available;
  const checking = nativeChecking || !credentialAvailability.checked;

  useEffect(() => {
    setIsAvailable(nativeAvailability.f5Status.available);
    setIsChatterboxAvailable(nativeAvailability.chatterboxStatus.available);
    setIsEdgeTTSAvailable(nativeAvailability.edgeTtsStatus.available);
    setIsGTTSAvailable(nativeAvailability.gttsStatus.available);
    setIsGeminiAvailable(geminiAvailable);
    setIsCheckingAvailability(checking);

    // Readiness is passive status, not an attempted operation. The render layer already disables
    // unavailable methods and explains where to install/start them. Writing that status into the
    // shared action-error channel made `useNarrationEffects` emit a red toast merely because the
    // editor mounted — commonly while a user was importing subtitles. Only an explicit narration
    // action may populate that error channel.
  }, [
    checking,
    credentialAvailability.available,
    geminiAvailable,
    geminiBackendAvailable,
    nativeAvailability,
    setIsAvailable,
    setIsChatterboxAvailable,
    setIsCheckingAvailability,
    setIsEdgeTTSAvailable,
    setIsGTTSAvailable,
    setIsGeminiAvailable,
  ]);

  return {
    geminiUnavailableReason: checking
      ? 'checking'
      : !geminiBackendAvailable
        ? 'engine'
        : !credentialAvailability.available
          ? 'credential'
          : null,
    geminiCredentialReason: credentialAvailability.reason,
  };
};

export default useAvailabilityCheck;
