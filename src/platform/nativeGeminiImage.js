import { Channel } from '@tauri-apps/api/core';

import {
  getActiveGeminiCredentialId,
  getCredentialStateSnapshot,
  refreshCredentialState,
  rotateGeminiCredential,
} from './credentialStateController';
import {
  cancelGeminiJob,
  normalizeJobSnapshot,
} from './geminiService';
import { importReferenceImage, releaseReferenceImage } from './imageService';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const IMAGE_MODEL = 'gemini-3.1-flash-image';
const MAX_PROMPT_CHARACTERS = 1_048_576;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 8;
const RAW_IMAGE_DELIVERY_TIMEOUT_MS = 10_000;
const RETRYABLE_CREDENTIAL_CODES = new Set([
  'geminiCredentialRejected',
  'geminiRateLimited',
]);

const isPlainRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const hasExactKeys = (value, expected) => {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
};

const fixedError = (code = 'nativeGeminiImageFailed') => {
  const error = new Error('The native Gemini image operation could not be completed');
  error.name = 'NativeGeminiImageError';
  error.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code)
    ? code
    : 'nativeGeminiImageFailed';
  return error;
};

const cancelledError = () => {
  const error = new Error('The Gemini image request was cancelled');
  error.name = 'AbortError';
  error.code = 'geminiCancelled';
  return error;
};

const requirePrompt = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) throw fixedError('invalidImageRequest');
  let characters = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) {
    characters += 1;
    if (characters > MAX_PROMPT_CHARACTERS) throw fixedError('invalidImageRequest');
  }
  return value;
};

const normalizeBytes = (value) => {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value.slice(0));
  } else if (value instanceof Uint8Array) {
    bytes = value.slice();
  } else {
    throw fixedError('invalidGeminiImageResponse');
  }
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw fixedError('invalidGeminiImageResponse');
  }
  return bytes;
};

const normalizeError = (value) => {
  if (!hasExactKeys(value, ['code', 'message'])
      || typeof value.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value.code)
      || typeof value.message !== 'string'
      || value.message.length > 2_048) {
    throw fixedError('invalidGeminiImageResponse');
  }
  return fixedError(value.code);
};

const normalizeEvent = (value) => {
  if (!isPlainRecord(value) || typeof value.event !== 'string') {
    throw fixedError('invalidGeminiImageResponse');
  }
  switch (value.event) {
    case 'completed': {
      if (!hasExactKeys(value, ['event', 'job', 'mimeType', 'sizeBytes'])
          || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mimeType)
          || !Number.isSafeInteger(value.sizeBytes)
          || value.sizeBytes < 1
          || value.sizeBytes > MAX_IMAGE_BYTES) {
        throw fixedError('invalidGeminiImageResponse');
      }
      const job = normalizeJobSnapshot(value.job);
      if (job.kind !== 'generateImage' || job.state !== 'succeeded') {
        throw fixedError('invalidGeminiImageResponse');
      }
      return Object.freeze({ ...value, job });
    }
    case 'cancelled': {
      if (!hasExactKeys(value, ['event', 'job'])) throw fixedError('invalidGeminiImageResponse');
      const job = normalizeJobSnapshot(value.job);
      if (job.kind !== 'generateImage' || job.state !== 'cancelled') {
        throw fixedError('invalidGeminiImageResponse');
      }
      return Object.freeze({ event: 'cancelled', job });
    }
    case 'failed': {
      if (!hasExactKeys(value, ['event', 'job', 'error'])) {
        throw fixedError('invalidGeminiImageResponse');
      }
      const job = value.job === null ? null : normalizeJobSnapshot(value.job);
      if (job !== null && (job.kind !== 'generateImage' || job.state !== 'failed')) {
        throw fixedError('invalidGeminiImageResponse');
      }
      return Object.freeze({ event: 'failed', job, error: normalizeError(value.error) });
    }
    default:
      throw fixedError('invalidGeminiImageResponse');
  }
};

const runAttempt = async ({
  credentialId,
  referenceAssetId,
  prompt,
  model,
  signal,
  invokeCommand,
  ChannelConstructor,
  cancel,
}) => {
  if (signal?.aborted) throw cancelledError();
  let initial = null;
  let imageBytes = null;
  let completion = null;
  let terminal = false;
  let deliveryTimeout = null;
  let cancelPromise = null;
  const pending = [];
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });

  const settle = (outcome) => {
    if (terminal) return;
    terminal = true;
    if (deliveryTimeout !== null) clearTimeout(deliveryTimeout);
    resolveTerminal(outcome);
  };
  const cancelStarted = () => {
    if (initial === null || cancelPromise !== null) return cancelPromise;
    cancelPromise = cancel(initial.id).catch(() => null);
    return cancelPromise;
  };
  const protocolFailure = () => {
    cancelStarted();
    settle({ error: fixedError('invalidGeminiImageResponse') });
  };
  const maybeComplete = () => {
    if (completion === null || imageBytes === null || terminal) return;
    if (imageBytes.byteLength !== completion.sizeBytes) {
      protocolFailure();
      return;
    }
    settle({ result: Object.freeze({
      bytes: imageBytes,
      mimeType: completion.mimeType,
      job: completion.job,
    }) });
  };
  const dispatch = (message) => {
    if (terminal) {
      protocolFailure();
      return;
    }
    if (message.kind === 'image') {
      if (imageBytes !== null) {
        protocolFailure();
        return;
      }
      imageBytes = message.bytes;
      maybeComplete();
      return;
    }
    const event = message.event;
    if (event.job !== null && event.job.id !== initial.id) {
      protocolFailure();
      return;
    }
    if (event.event === 'completed') {
      if (completion !== null) {
        protocolFailure();
        return;
      }
      completion = event;
      if (imageBytes === null) {
        deliveryTimeout = setTimeout(protocolFailure, RAW_IMAGE_DELIVERY_TIMEOUT_MS);
      }
      maybeComplete();
    } else if (event.event === 'cancelled') {
      settle({ error: cancelledError() });
    } else {
      settle({ error: event.error });
    }
  };
  const queueOrDispatch = (message) => {
    if (initial !== null) {
      dispatch(message);
      return;
    }
    if (pending.length >= MAX_PENDING_MESSAGES) {
      protocolFailure();
      return;
    }
    pending.push(message);
  };

  const eventChannel = new ChannelConstructor();
  const imageChannel = new ChannelConstructor();
  eventChannel.onmessage = (raw) => {
    try {
      queueOrDispatch({ kind: 'event', event: normalizeEvent(raw) });
    } catch {
      protocolFailure();
    }
  };
  imageChannel.onmessage = (raw) => {
    try {
      queueOrDispatch({ kind: 'image', bytes: normalizeBytes(raw) });
    } catch {
      protocolFailure();
    }
  };

  const handleAbort = () => {
    cancelStarted();
    settle({ error: cancelledError() });
  };
  signal?.addEventListener('abort', handleAbort, { once: true });
  try {
    try {
      initial = normalizeJobSnapshot(await invokeCommand('gemini_image_start', {
        request: { credentialId, model, prompt, referenceAssetId },
        onEvent: eventChannel,
        onImage: imageChannel,
      }));
    } catch (error) {
      throw fixedError(error?.code);
    }
    if (initial.kind !== 'generateImage' || initial.state !== 'running') {
      protocolFailure();
    }
    if (terminal) cancelStarted();
    pending.splice(0).forEach(dispatch);
    if (signal?.aborted) handleAbort();
    const outcome = await terminalPromise;
    if (outcome.error) throw outcome.error;
    return outcome.result;
  } finally {
    signal?.removeEventListener('abort', handleAbort);
  }
};

export const createNativeGeminiImage = ({
  prepareCredentials = refreshCredentialState,
  getCredentialId = getActiveGeminiCredentialId,
  getCredentialSnapshot = getCredentialStateSnapshot,
  rotateCredential = rotateGeminiCredential,
  importImage = importReferenceImage,
  releaseImage = releaseReferenceImage,
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  cancel = cancelGeminiJob,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const generate = async ({ referenceBlob, prompt, model = IMAGE_MODEL, signal } = {}) => {
    if (!isNativeRuntime()) throw fixedError('desktopRuntimeUnavailable');
    if (model !== IMAGE_MODEL) throw fixedError('invalidImageModel');
    const normalizedPrompt = requirePrompt(prompt);
    if (signal?.aborted) throw cancelledError();
    const reference = await importImage(referenceBlob);
    try {
      await prepareCredentials();
      const snapshot = getCredentialSnapshot();
      const maximumAttempts = Math.max(
        1,
        snapshot?.gemini?.availableCredentialIds?.length ?? 0
      );
      const attempted = new Set();
      let lastError = fixedError('geminiCredentialUnavailable');
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        if (signal?.aborted) throw cancelledError();
        const credentialId = await getCredentialId();
        if (credentialId === null || attempted.has(credentialId)) break;
        attempted.add(credentialId);
        try {
          return await runAttempt({
            credentialId,
            referenceAssetId: reference.assetId,
            prompt: normalizedPrompt,
            model,
            signal,
            invokeCommand,
            ChannelConstructor,
            cancel,
          });
        } catch (error) {
          lastError = error;
          if (!RETRYABLE_CREDENTIAL_CODES.has(error?.code)
              || signal?.aborted
              || attempt + 1 >= maximumAttempts) {
            throw error;
          }
          await rotateCredential({ cooldownCredentialId: credentialId });
        }
      }
      throw lastError;
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'NativeGeminiImageError') throw error;
      throw fixedError(error?.code);
    } finally {
      await releaseImage(reference.assetId).catch(() => undefined);
    }
  };

  return Object.freeze({ generate });
};

const nativeGeminiImage = createNativeGeminiImage();

export const generateNativeGeminiImage = nativeGeminiImage.generate;
