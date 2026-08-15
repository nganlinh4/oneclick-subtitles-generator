import { useEffect, useRef, useState } from 'react';
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
const checkingCredential = Object.freeze({
  checked: false,
  available: false,
  reason: 'checking',
});

export const unavailableNativeNarrationAvailability = () => Object.freeze(
  Object.fromEntries(availabilityBackends.map(({ key }) => [key, unavailable('unavailable')]))
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

export const checkNativeNarrationAvailability = async (
  adapter = nativeNarrationAdapter,
  { probeInstalled = false } = {}
) => {
  const initialStatus = await adapter.getStatus();
  if (!probeInstalled) {
    return Object.freeze(Object.fromEntries(availabilityBackends.map(({ key, backend }) => {
      const snapshot = findBackend(initialStatus, backend);
      return [key, isReadyAndWarm(snapshot)
        ? available
        : unavailable(snapshot?.installed ? 'not-ready' : 'not-installed')];
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

  if (![...probeOutcomes.values()].includes('probed')) {
    return Object.freeze(Object.fromEntries(availabilityBackends.map(({ key, backend }) => (
      [key, unavailable(probeOutcomes.get(backend))]
    ))));
  }

  // Re-read authoritative state after the explicit probe. Native lifecycle epochs make a
  // concurrent Stop final, so this layer only reports the verified snapshot and never repairs or
  // restarts engine state on its own.
  const verifiedStatus = await adapter.getStatus();
  const entries = availabilityBackends.map(({ key, backend }) => {
    const outcome = probeOutcomes.get(backend);
    if (outcome === 'not-installed') return [key, unavailable('not-installed')];
    if (outcome !== 'probed') return [key, unavailable('probe-failed')];
    const snapshot = findBackend(verifiedStatus, backend);
    if (isReadyAndWarm(snapshot)) return [key, available];
    return [key, unavailable(snapshot?.installed ? 'not-ready' : 'not-installed')];
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
  narrationMethod,
  setIsAvailable,
  setIsGeminiAvailable,
  setIsChatterboxAvailable,
  setIsEdgeTTSAvailable,
  setIsGTTSAvailable,
  setIsCheckingAvailability,
  setError,
  t
}) => {
  const [nativeAvailability, setNativeAvailability] = useState(
    unavailableNativeNarrationAvailability
  );
  const [nativeChecking, setNativeChecking] = useState(true);
  const [credentialAvailability, setCredentialAvailability] = useState(checkingCredential);
  const availabilityErrorRef = useRef('');

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
          [binding.key]: isReadyAndWarm(snapshot)
            ? available
            : unavailable(snapshot.installed ? 'not-ready' : 'not-installed'),
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
        next = unavailableNativeNarrationAvailability();
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
    // Starting a speech worker is an explicit Settings > Tools action. Availability inspection is
    // status-only so mounting or switching narration methods can never restart a stopped engine.
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

    const currentStatus = {
      f5tts: nativeAvailability.f5Status,
      chatterbox: nativeAvailability.chatterboxStatus,
      'edge-tts': nativeAvailability.edgeTtsStatus,
      gtts: nativeAvailability.gttsStatus,
    }[narrationMethod];
    let nextAvailabilityError = '';
    if (narrationMethod === 'gemini' && !checking) {
      if (!geminiBackendAvailable) {
        nextAvailabilityError = t(
          'narration.engineUnavailableMessage',
          'This narration engine is not ready. Install or start it in Settings > Voice & transcription engines.'
        );
      } else if (!credentialAvailability.available) {
        nextAvailabilityError = t(
          'narration.geminiCredentialUnavailableMessage',
          'Gemini narration needs a usable API key. Add or replace one in Settings > API Keys.'
        );
      }
    } else if (currentStatus && !currentStatus.available) {
      nextAvailabilityError = t(
        'narration.engineUnavailableMessage',
        'This narration engine is not ready. Install or start it in Settings > Voice & transcription engines.'
      );
    }

    // Availability polling must not erase generation/runtime errors owned by other hooks.
    const previousAvailabilityError = availabilityErrorRef.current;
    availabilityErrorRef.current = nextAvailabilityError;
    setError((currentError) => (
      currentError === '' || currentError === previousAvailabilityError
        ? nextAvailabilityError
        : currentError
    ));
  }, [
    checking,
    credentialAvailability.available,
    geminiAvailable,
    geminiBackendAvailable,
    narrationMethod,
    nativeAvailability,
    setError,
    setIsAvailable,
    setIsChatterboxAvailable,
    setIsCheckingAvailability,
    setIsEdgeTTSAvailable,
    setIsGTTSAvailable,
    setIsGeminiAvailable,
    t,
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
