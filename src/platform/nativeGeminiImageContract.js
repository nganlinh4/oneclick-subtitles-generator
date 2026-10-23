/**
 * Wire contract for native Gemini image commands: bounded request validation and exact-shape
 * normalization of every descriptor, playback and job event the Rust host returns.
 */
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { normalizeJobSnapshot } from './geminiService';
import { isNativeMediaPlaybackUrl } from './mediaService';

const MAX_PROMPT_CHARACTERS = 1_048_576;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PROJECT_IMAGES = 64;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

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

export const fixedError = (code = 'nativeGeminiImageFailed') => {
  const error = new Error('The native Gemini image operation could not be completed');
  error.name = 'NativeGeminiImageError';
  error.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code)
    ? code
    : 'nativeGeminiImageFailed';
  return error;
};

export const cancelledError = () => {
  const error = new Error('The Gemini image request was cancelled');
  error.name = 'AbortError';
  error.code = 'geminiCancelled';
  return error;
};

export const requireProjectId = (value) => {
  if (!uuidHasVersion(value, 7)) throw fixedError('invalidImageProject');
  return value;
};

export const requireArtifactId = (value) => {
  if (!uuidHasVersion(value, 7)) throw fixedError('invalidGeneratedImageRequest');
  return value;
};

export const requirePrompt = (value) => {
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

const normalizeGeneratedImageDescriptor = (value, expectedProjectId = null) => {
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

export const normalizeEvent = (value, expectedProjectId) => {
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

export const normalizeImageList = (value, projectId) => {
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

export const requireExportName = (value) => {
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
