import {
  acquireGeminiCredential,
  getCredentialStateSnapshot,
  refreshCredentialState,
  rotateGeminiCredential,
} from './credentialStateController';
import {
  cancelGeminiJob,
  startGeminiJob,
} from './geminiService';
import { acknowledgeJobResult } from './jobResultDeliveryService';
import {
  acknowledgeRecoveredNativeJob,
  claimRecoveredGeminiJob,
  ensureNativeJobRecoveryReady,
} from './jobRecoveryCoordinator';

const RETRYABLE_CREDENTIAL_CODES = new Set([
  'geminiCredentialRejected',
  'geminiRateLimited',
]);

const fixedError = (code = 'nativeGeminiFailed') => {
  const error = new Error('The native Gemini operation could not be completed');
  error.name = 'NativeGeminiError';
  error.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code)
    ? code
    : 'nativeGeminiFailed';
  return error;
};

const cancelledError = () => {
  const error = new Error('The Gemini request was cancelled');
  error.name = 'AbortError';
  error.code = 'geminiCancelled';
  return error;
};

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

const recoveryKeyFor = async (request) => {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw fixedError('geminiRecoveryUnavailable');
  // Project revision ownership already binds the exact current media. Segment clipping may mint a
  // new derived asset ID after reload, so that process-local ID must not make the same request
  // unrecoverable. Unowned requests still bind their media asset directly.
  const identity = request.projectId === undefined
    ? request
    : { ...request, mediaAssetId: null };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(identity)));
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const recoveredResult = (entry, acknowledgeRecovered) => {
  const { payload } = entry.value.delivery;
  let acknowledgement = null;
  let acknowledged = false;
  const acknowledgeConsumption = () => {
    if (acknowledged) return Promise.resolve();
    acknowledgement ??= Promise.resolve()
      .then(() => acknowledgeRecovered(entry))
      .then(() => { acknowledged = true; })
      .finally(() => { acknowledgement = null; });
    return acknowledgement;
  };
  return Object.freeze({
    text: payload.text,
    usage: payload.usage ?? null,
    job: entry.job,
    deliveryId: entry.value.delivery.deliveryId,
    acknowledge: acknowledgeConsumption,
  });
};

const runAttempt = async ({
  credentialId,
  request,
  signal,
  onChunk,
  onStarted,
  start,
  cancel,
  acknowledge,
}) => {
  if (signal?.aborted) throw cancelledError();

  let initial = null;
  let terminal = null;
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
  const settle = (outcome) => {
    if (terminal !== null) return;
    terminal = outcome;
    resolveTerminal(outcome);
  };
  const requestCancellation = () => {
    settle({ kind: 'cancelled' });
    if (initial !== null) cancel(initial.id).catch(() => undefined);
  };
  signal?.addEventListener('abort', requestCancellation, { once: true });

  try {
    initial = await start({ ...request, credentialId }, {
      onChunk: (event) => {
        if (typeof onChunk !== 'function') return;
        try { onChunk(event.text); } catch { /* isolate consumer callback failures */ }
      },
      onCompleted: (event) => settle({ kind: 'completed', event }),
      onCancelled: () => settle({ kind: 'cancelled' }),
      onFailed: (event) => settle({
        kind: 'failed',
        error: fixedError(event.error.code),
      }),
      onProtocolError: () => {
        settle({
          kind: 'protocolError',
          error: fixedError('invalidGeminiResponse'),
        });
        if (initial !== null) cancel(initial.id).catch(() => undefined);
      },
    });

    if (signal?.aborted || terminal?.kind === 'protocolError') {
      await cancel(initial.id).catch(() => undefined);
    } else if (terminal === null && typeof onStarted === 'function') {
      try { onStarted(initial.id); } catch { /* isolate consumer callback failures */ }
    }

    const outcome = await terminalPromise;
    if (outcome.kind === 'completed') {
      let acknowledgement = null;
      let acknowledged = false;
      const acknowledgeConsumption = () => {
        if (acknowledged) return Promise.resolve();
        acknowledgement ??= Promise.resolve()
          .then(() => acknowledge(outcome.event.job.id, outcome.event.deliveryId))
          .then(() => { acknowledged = true; })
          .finally(() => { acknowledgement = null; });
        return acknowledgement;
      };
      return Object.freeze({
        text: outcome.event.text,
        usage: outcome.event.usage,
        job: outcome.event.job,
        deliveryId: outcome.event.deliveryId,
        acknowledge: acknowledgeConsumption,
      });
    }
    if (outcome.kind === 'cancelled') throw cancelledError();
    throw outcome.error;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'geminiCancelled') {
      throw cancelledError();
    }
    if (error?.name === 'NativeGeminiError') throw error;
    throw fixedError(error?.code);
  } finally {
    signal?.removeEventListener('abort', requestCancellation);
  }
};

export const createNativeGeminiJobRunner = ({
  prepareCredentials = refreshCredentialState,
  getCredentialId = acquireGeminiCredential,
  getCredentialSnapshot = getCredentialStateSnapshot,
  rotateCredential = rotateGeminiCredential,
  start = startGeminiJob,
  cancel = cancelGeminiJob,
  acknowledge = acknowledgeJobResult,
  ensureRecovery = ensureNativeJobRecoveryReady,
  claimRecovered = claimRecoveredGeminiJob,
  acknowledgeRecovered = acknowledgeRecoveredNativeJob,
} = {}) => {
  const run = async ({ request, signal, onChunk, onStarted }) => {
    if (signal?.aborted) throw cancelledError();
    const recoveryKey = await recoveryKeyFor(request);
    await ensureRecovery();
    if (signal?.aborted) throw cancelledError();
    const recoveryRequest = Object.freeze({ ...request, recoveryKey });
    const recovered = claimRecovered(recoveryRequest);
    if (recovered !== null) return recoveredResult(recovered, acknowledgeRecovered);
    try {
      await prepareCredentials();
    } catch (error) {
      throw fixedError(error?.code ?? 'geminiCredentialUnavailable');
    }
    if (signal?.aborted) throw cancelledError();

    const snapshot = getCredentialSnapshot();
    const maximumAttempts = Math.max(
      1,
      snapshot?.gemini?.availableCredentialIds?.length ?? 0
    );
    const attemptedCredentials = new Set();
    let lastError = fixedError('geminiCredentialUnavailable');

    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (signal?.aborted) throw cancelledError();
      const credentialId = await getCredentialId();
      if (credentialId === null || attemptedCredentials.has(credentialId)) break;
      attemptedCredentials.add(credentialId);

      let attemptProducedChunk = false;
      try {
        return await runAttempt({
          credentialId,
          request: recoveryRequest,
          signal,
          onChunk: typeof onChunk === 'function'
            ? (text) => {
                attemptProducedChunk = true;
                onChunk(text);
              }
            : undefined,
          onStarted,
          start,
          cancel,
          acknowledge,
        });
      } catch (error) {
        lastError = error;
        if (attemptProducedChunk
            || !RETRYABLE_CREDENTIAL_CODES.has(error?.code)
            || signal?.aborted
            || attempt + 1 >= maximumAttempts) {
          throw error;
        }
        try {
          await rotateCredential({ cooldownCredentialId: credentialId });
        } catch (rotationError) {
          throw fixedError(rotationError?.code ?? 'geminiCredentialRotationFailed');
        }
      }
    }

    throw lastError;
  };

  return Object.freeze({ run });
};
