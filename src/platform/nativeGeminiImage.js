import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import {
  getActiveGeminiCredentialId,
  getCredentialStateSnapshot,
  refreshCredentialState,
  rotateGeminiCredential,
} from './credentialStateController';
import { cancelGeminiJob, normalizeJobSnapshot } from './geminiService';
import { importReferenceImage, releaseReferenceImage } from './imageService';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { isNativeMediaPlaybackUrl } from './mediaService';
import { resolveProjectForCache } from './subtitleProjectStore';
import { getCurrentCacheId } from '../utils/userSubtitlesStore';

const IMAGE_MODEL = 'gemini-3.1-flash-image';
const MAX_PROMPT_CHARACTERS = 1_048_576;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_IMAGES = 64;
const MAX_PENDING_MESSAGES = 8;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
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

const uuidHasVersion = (value, expected) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expected;
  } catch {
    return false;
  }
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

const requireProjectId = (value) => {
  if (!uuidHasVersion(value, 7)) throw fixedError('invalidImageProject');
  return value;
};

const requireArtifactId = (value) => {
  if (!uuidHasVersion(value, 7)) throw fixedError('invalidGeneratedImageRequest');
  return value;
};

const requirePrompt = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fixedError('invalidImageRequest');
  }
  let characters = 0;
  for (const _character of value) {
    characters += 1;
    if (characters > MAX_PROMPT_CHARACTERS) throw fixedError('invalidImageRequest');
  }
  return value;
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

export const normalizeGeneratedImageDescriptor = (value, expectedProjectId = null) => {
  if (!hasExactKeys(value, [
    'artifactId', 'projectId', 'mimeType', 'sizeBytes', 'createdAtMs',
  ])
      || !uuidHasVersion(value.artifactId, 7)
      || !uuidHasVersion(value.projectId, 7)
      || (expectedProjectId !== null && value.projectId !== expectedProjectId)
      || !IMAGE_MIME_TYPES.has(value.mimeType)
      || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes < 1
      || value.sizeBytes > MAX_IMAGE_BYTES
      || !Number.isSafeInteger(value.createdAtMs)
      || value.createdAtMs < 0) {
    throw fixedError('invalidGeminiImageResponse');
  }
  return Object.freeze({ ...value });
};

const normalizePlayback = (value, artifact) => {
  if (!hasExactKeys(value, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
      || !uuidHasVersion(value.id, 4)
      || !isNativeMediaPlaybackUrl(value.playbackUrl, value.id)
      || value.mimeType !== artifact.mimeType
      || value.byteLength !== artifact.sizeBytes) {
    throw fixedError('invalidGeminiImageResponse');
  }
  return Object.freeze({ ...value });
};

export const normalizePlayableGeneratedImage = (value, expectedProjectId = null) => {
  if (!hasExactKeys(value, ['artifact', 'playback'])) {
    throw fixedError('invalidGeminiImageResponse');
  }
  const artifact = normalizeGeneratedImageDescriptor(value.artifact, expectedProjectId);
  return Object.freeze({ artifact, playback: normalizePlayback(value.playback, artifact) });
};

const normalizeEvent = (value, expectedProjectId) => {
  if (!isPlainRecord(value) || typeof value.event !== 'string') {
    throw fixedError('invalidGeminiImageResponse');
  }
  switch (value.event) {
    case 'prepared': {
      if (!hasExactKeys(value, ['event', 'job', 'image'])) {
        throw fixedError('invalidGeminiImageResponse');
      }
      const job = normalizeJobSnapshot(value.job);
      if (job.kind !== 'generateImage' || job.state !== 'running') {
        throw fixedError('invalidGeminiImageResponse');
      }
      return Object.freeze({
        event: 'prepared',
        job,
        image: normalizePlayableGeneratedImage(value.image, expectedProjectId),
      });
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

const activeProjectIdentity = async ({ getCacheId, resolveProject }) => {
  const cacheId = getCacheId();
  if (typeof cacheId !== 'string' || cacheId.length === 0) {
    throw fixedError('imageProjectUnavailable');
  }
  let active;
  try {
    active = await resolveProject(cacheId, { create: true });
  } catch {
    throw fixedError('imageProjectUnavailable');
  }
  const confirmedCacheId = getCacheId();
  if (confirmedCacheId !== cacheId || active?.cacheId !== cacheId) {
    throw fixedError('imageProjectUnavailable');
  }
  return Object.freeze({ cacheId, projectId: requireProjectId(active?.projectId) });
};

const runAttempt = async ({
  credentialId,
  referenceAssetId,
  projectId,
  prompt,
  model,
  signal,
  invokeCommand,
  ChannelConstructor,
  cancel,
  complete,
  releaseCompleted,
}) => {
  if (signal?.aborted) throw cancelledError();
  let initial = null;
  let terminal = false;
  let cancelPromise = null;
  let completionStarted = false;
  let terminalKind = null;
  const releasedPlaybackIds = new Set();
  const pending = [];
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });

  const settle = (outcome, kind) => {
    if (terminal) return;
    terminal = true;
    terminalKind = kind;
    resolveTerminal(outcome);
  };
  const cancelStarted = () => {
    if (initial === null || cancelPromise !== null) return cancelPromise;
    cancelPromise = cancel(initial.id).catch(() => null);
    return cancelPromise;
  };
  const protocolFailure = () => {
    cancelStarted();
    settle({ error: fixedError('invalidGeminiImageResponse') }, 'error');
  };
  const releasePrepared = (image) => {
    const playbackId = image?.playback?.id;
    if (typeof playbackId !== 'string' || releasedPlaybackIds.has(playbackId)) return;
    releasedPlaybackIds.add(playbackId);
    void releaseCompleted(image).catch(() => undefined);
  };
  const dispatch = (event) => {
    if (event.job !== null && event.job.id !== initial.id) {
      protocolFailure();
      return;
    }
    if (terminal) {
      if (terminalKind !== 'success' && event.event === 'prepared') {
        releasePrepared(event.image);
      }
      return;
    }
    if (event.event === 'prepared') {
      if (completionStarted) {
        protocolFailure();
        return;
      }
      completionStarted = true;
      void complete({
        jobId: event.job.id,
        projectId: event.image.artifact.projectId,
        artifactId: event.image.artifact.artifactId,
        playbackId: event.image.playback.id,
      }).then((rawJob) => {
        const job = normalizeJobSnapshot(rawJob);
        if (job.id !== event.job.id || job.kind !== 'generateImage' || job.state !== 'succeeded') {
          throw fixedError('invalidGeminiImageResponse');
        }
        if (terminal) {
          if (terminalKind !== 'success') releasePrepared(event.image);
          return;
        }
        settle({ result: Object.freeze({ image: event.image, job }) }, 'success');
      }).catch((error) => {
        releasePrepared(event.image);
        if (!terminal) {
          settle(
            { error: signal?.aborted ? cancelledError() : fixedError(error?.code) },
            signal?.aborted ? 'cancelled' : 'error'
          );
        }
      });
    } else if (event.event === 'cancelled') {
      settle({ error: cancelledError() }, 'cancelled');
    } else {
      settle({ error: event.error }, 'error');
    }
  };
  const queueOrDispatch = (event) => {
    if (initial !== null) {
      dispatch(event);
      return;
    }
    if (pending.length >= MAX_PENDING_MESSAGES) {
      protocolFailure();
      return;
    }
    pending.push(event);
  };

  const eventChannel = new ChannelConstructor();
  eventChannel.onmessage = (raw) => {
    try {
      queueOrDispatch(normalizeEvent(raw, projectId));
    } catch {
      protocolFailure();
    }
  };

  const handleAbort = () => {
    cancelStarted();
    if (!completionStarted) settle({ error: cancelledError() }, 'cancelled');
  };
  signal?.addEventListener('abort', handleAbort, { once: true });
  try {
    try {
      initial = normalizeJobSnapshot(await invokeCommand('gemini_image_start', {
        request: { credentialId, model, prompt, referenceAssetId, projectId },
        onEvent: eventChannel,
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

const normalizeImageList = (value, projectId) => {
  if (!Array.isArray(value) || value.length > MAX_PROJECT_IMAGES) {
    throw fixedError('invalidGeminiImageResponse');
  }
  const seen = new Set();
  return Object.freeze(value.map((entry) => {
    const normalized = normalizeGeneratedImageDescriptor(entry, projectId);
    if (seen.has(normalized.artifactId)) throw fixedError('invalidGeminiImageResponse');
    seen.add(normalized.artifactId);
    return normalized;
  }));
};

const requireExportName = (value) => {
  if (typeof value !== 'string'
      || value.length < 5
      || value.length > 240
      || !Array.from(value).every((character) => character.codePointAt(0) <= 0x7f)) {
    throw fixedError('invalidGeneratedImageRequest');
  }
  const separator = value.lastIndexOf('.');
  const stem = value.slice(0, separator);
  const extension = value.slice(separator + 1).toLowerCase();
  if (separator < 1
      || stem.endsWith('.')
      || !/^[A-Za-z0-9_.-]+$/.test(stem)
      || !['png', 'jpg', 'webp'].includes(extension)) {
    throw fixedError('invalidGeneratedImageRequest');
  }
  return value;
};

export const createNativeGeminiImage = ({
  prepareCredentials = refreshCredentialState,
  getCredentialId = getActiveGeminiCredentialId,
  getCredentialSnapshot = getCredentialStateSnapshot,
  rotateCredential = rotateGeminiCredential,
  importImage = importReferenceImage,
  releaseImage = releaseReferenceImage,
  getCacheId = getCurrentCacheId,
  resolveProject = resolveProjectForCache,
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  cancel = cancelGeminiJob,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const projectLookup = { getCacheId, resolveProject };
  const requireNative = () => {
    if (!isNativeRuntime()) throw fixedError('desktopRuntimeUnavailable');
  };
  const requireCurrentCache = (capturedIdentity) => {
    if (getCacheId() !== capturedIdentity.cacheId) {
      throw fixedError('staleGeminiImageProject');
    }
  };
  const requireCurrentProject = async (capturedProjectId) => {
    const captured = requireProjectId(capturedProjectId);
    let current;
    try {
      current = await activeProjectIdentity(projectLookup);
    } catch {
      throw fixedError('staleGeminiImageProject');
    }
    if (current.projectId !== captured) throw fixedError('staleGeminiImageProject');
    return current;
  };
  const requireSameProjectIdentity = async (capturedIdentity) => {
    const current = await requireCurrentProject(capturedIdentity.projectId);
    if (current.cacheId !== capturedIdentity.cacheId) {
      throw fixedError('staleGeminiImageProject');
    }
    return capturedIdentity;
  };

  const releasePlayback = async (playable) => {
    requireNative();
    const image = normalizePlayableGeneratedImage(playable);
    const released = await invokeCommand('generated_image_playback_release', {
      request: {
        projectId: image.artifact.projectId,
        artifactId: image.artifact.artifactId,
        playbackId: image.playback.id,
      },
    });
    if (typeof released !== 'boolean') throw fixedError('invalidGeminiImageResponse');
    return released;
  };

  const completePrepared = async ({ jobId, projectId, artifactId, playbackId }) => {
    const request = { jobId, projectId, artifactId, playbackId };
    let firstError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await invokeCommand('gemini_image_complete', { request });
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError;
  };

  const generate = async ({ referencePlaybackUrl, prompt, model = IMAGE_MODEL, signal } = {}) => {
    requireNative();
    if (model !== IMAGE_MODEL) throw fixedError('invalidImageModel');
    const normalizedPrompt = requirePrompt(prompt);
    if (signal?.aborted) throw cancelledError();
    const projectIdentity = await activeProjectIdentity(projectLookup);
    const { projectId } = projectIdentity;
    const reference = await importImage(referencePlaybackUrl, projectId);
    try {
      await requireSameProjectIdentity(projectIdentity);
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
          await requireSameProjectIdentity(projectIdentity);
          requireCurrentCache(projectIdentity);
          const result = await runAttempt({
            credentialId,
            referenceAssetId: reference.assetId,
            projectId,
            prompt: normalizedPrompt,
            model,
            signal,
            invokeCommand,
            ChannelConstructor,
            cancel,
            complete: completePrepared,
            releaseCompleted: releasePlayback,
          });
          let currentProjectId;
          try {
            currentProjectId = (await activeProjectIdentity(projectLookup)).projectId;
          } catch {
            currentProjectId = null;
          }
          if (currentProjectId !== projectId) {
            await releasePlayback(result.image).catch(() => undefined);
            throw fixedError('staleGeminiImageResult');
          }
          return result;
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

  const list = async (projectId) => {
    requireNative();
    const id = requireProjectId(projectId);
    return normalizeImageList(
      await invokeCommand('generated_image_list', { request: { projectId: id } }),
      id
    );
  };

  const resolve = async ({ projectId, artifactId }) => {
    requireNative();
    const id = requireProjectId(projectId);
    const artifact = requireArtifactId(artifactId);
    return normalizePlayableGeneratedImage(
      await invokeCommand('generated_image_resolve', {
        request: { projectId: id, artifactId: artifact },
      }),
      id
    );
  };

  const load = async (projectId) => {
    const id = requireProjectId(projectId);
    const descriptors = await list(id);
    const resolved = [];
    try {
      for (const descriptor of descriptors) {
        resolved.push(await resolve({ projectId: id, artifactId: descriptor.artifactId }));
      }
      return Object.freeze(resolved);
    } catch (error) {
      await Promise.allSettled(resolved.map((playable) => releasePlayback(playable)));
      throw error;
    }
  };

  const exportImage = async ({ projectId, artifactId, suggestedName }) => {
    requireNative();
    const capturedProjectId = requireProjectId(projectId);
    const artifact = requireArtifactId(artifactId);
    const exportName = requireExportName(suggestedName);
    const capturedIdentity = await requireCurrentProject(capturedProjectId);
    requireCurrentCache(capturedIdentity);
    const saved = await invokeCommand('generated_image_export', {
      request: {
        projectId: capturedProjectId,
        artifactId: artifact,
        suggestedName: exportName,
      },
    });
    if (typeof saved !== 'boolean') throw fixedError('invalidGeminiImageResponse');
    return saved;
  };

  const deleteImage = async ({ projectId, artifactId }) => {
    requireNative();
    const capturedProjectId = requireProjectId(projectId);
    const artifact = requireArtifactId(artifactId);
    const capturedIdentity = await requireCurrentProject(capturedProjectId);
    requireCurrentCache(capturedIdentity);
    const deleted = await invokeCommand('generated_image_delete', {
      request: {
        projectId: capturedProjectId,
        artifactId: artifact,
      },
    });
    if (typeof deleted !== 'boolean') throw fixedError('invalidGeminiImageResponse');
    return deleted;
  };

  const clear = async (projectId) => {
    requireNative();
    const capturedProjectId = requireProjectId(projectId);
    const capturedIdentity = await requireCurrentProject(capturedProjectId);
    requireCurrentCache(capturedIdentity);
    const removed = await invokeCommand('generated_image_clear', {
      request: { projectId: capturedProjectId },
    });
    if (!Number.isSafeInteger(removed) || removed < 0 || removed > MAX_PROJECT_IMAGES) {
      throw fixedError('invalidGeminiImageResponse');
    }
    return removed;
  };

  const getActiveProjectId = async () => {
    requireNative();
    return (await activeProjectIdentity(projectLookup)).projectId;
  };

  return Object.freeze({
    generate,
    list,
    resolve,
    load,
    exportImage,
    deleteImage,
    clear,
    releasePlayback,
    getActiveProjectId,
  });
};

const nativeGeminiImage = createNativeGeminiImage();

export const generateNativeGeminiImage = nativeGeminiImage.generate;
export const listNativeGeneratedImages = nativeGeminiImage.list;
export const resolveNativeGeneratedImage = nativeGeminiImage.resolve;
export const loadNativeGeneratedImages = nativeGeminiImage.load;
export const exportNativeGeneratedImage = nativeGeminiImage.exportImage;
export const deleteNativeGeneratedImage = nativeGeminiImage.deleteImage;
export const clearNativeGeneratedImages = nativeGeminiImage.clear;
export const releaseNativeGeneratedImagePlayback = nativeGeminiImage.releasePlayback;
export const getActiveGeneratedImageProjectId = nativeGeminiImage.getActiveProjectId;
