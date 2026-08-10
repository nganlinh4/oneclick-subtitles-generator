import {
  getActiveGeminiCredentialId,
  getCredentialStateSnapshot,
  refreshCredentialState,
  rotateGeminiCredential,
} from './credentialStateController';
import {
  cancelGeminiJob,
  startGeminiJob,
} from './geminiService';

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

const runAttempt = async ({
  credentialId,
  request,
  signal,
  onChunk,
  onStarted,
  start,
  cancel,
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
      return Object.freeze({
        text: outcome.event.text,
        usage: outcome.event.usage,
        job: outcome.event.job,
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
  getCredentialId = getActiveGeminiCredentialId,
  getCredentialSnapshot = getCredentialStateSnapshot,
  rotateCredential = rotateGeminiCredential,
  start = startGeminiJob,
  cancel = cancelGeminiJob,
} = {}) => {
  const run = async ({ request, signal, onChunk, onStarted }) => {
    if (signal?.aborted) throw cancelledError();
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

      try {
        return await runAttempt({
          credentialId,
          request,
          signal,
          onChunk,
          onStarted,
          start,
          cancel,
        });
      } catch (error) {
        lastError = error;
        if (!RETRYABLE_CREDENTIAL_CODES.has(error?.code)
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
