import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop } from './desktopRuntime';
import { isNativeMediaPlaybackUrl } from './mediaService';

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const IMAGE_FORMATS = Object.freeze({
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
});
const descriptorKeys = Object.freeze(['assetId', 'mimeType', 'sizeBytes']);
const playbackDescriptorKeys = Object.freeze(['id', 'playbackUrl', 'mimeType', 'byteLength']);
const PLAYBACK_URL_PATTERN = /^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])\/asset\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\?token=[0-9a-f]{64}$/i;

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

const isUuidVersion = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expectedVersion;
  } catch {
    return false;
  }
};

const isUuidV7 = (value) => isUuidVersion(value, 7);

const invalidRequest = () => {
  const error = new Error('The native reference-image request is invalid');
  error.name = 'ImageServiceError';
  error.code = 'invalidImageRequest';
  return error;
};

const invalidResponse = () => {
  const error = new Error('The desktop host returned invalid reference-image data');
  error.name = 'ImageServiceError';
  error.code = 'invalidImageResponse';
  return error;
};

const normalizeDescriptor = (value, expected = {}) => {
  if (!hasExactKeys(value, descriptorKeys)
      || !isUuidV7(value.assetId)
      || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes < 1
      || value.sizeBytes > MAX_REFERENCE_BYTES
      || !Object.values(IMAGE_FORMATS).includes(value.mimeType)
      || (expected.mimeType !== undefined && value.mimeType !== expected.mimeType)
      || (expected.sizeBytes !== undefined && value.sizeBytes !== expected.sizeBytes)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

const referencePlaybackId = (value) => {
  if (typeof value !== 'string' || value.length > 4_096) throw invalidRequest();
  const match = PLAYBACK_URL_PATTERN.exec(value);
  if (!match || !isUuidVersion(match[1], 4) || !isNativeMediaPlaybackUrl(value, match[1])) {
    throw invalidRequest();
  }
  return match[1];
};

const normalizeReferencePlayback = (value, projectId) => {
  if (!hasExactKeys(value, playbackDescriptorKeys)
      || !isUuidVersion(value.id, 4)
      || !isNativeMediaPlaybackUrl(value.playbackUrl, value.id)
      || !Object.values(IMAGE_FORMATS).includes(value.mimeType)
      || !Number.isSafeInteger(value.byteLength)
      || value.byteLength < 1
      || value.byteLength > MAX_REFERENCE_BYTES) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value, projectId });
};

const requireSuggestedName = (value) => {
  if (typeof value !== 'string'
      || value.length < 5
      || value.length > 240
      || !value.endsWith(value.trim())
      || !Array.from(value).every((character) => character.codePointAt(0) <= 0x7f)) {
    throw invalidRequest();
  }
  const separator = value.lastIndexOf('.');
  const stem = value.slice(0, separator);
  const extension = value.slice(separator + 1).toLowerCase();
  if (separator < 1
      || stem.endsWith('.')
      || !/^[A-Za-z0-9_.-]+$/.test(stem)
      || !['png', 'jpg', 'jpeg', 'webp'].includes(extension)) {
    throw invalidRequest();
  }
  return value;
};

export const importReferenceImage = async (playbackUrl, projectId) => {
  if (!isUuidV7(projectId)) throw invalidRequest();
  const descriptor = await invokeDesktop('image_blob_import_playback', {
    request: {
      playbackId: referencePlaybackId(playbackUrl),
      projectId,
    },
  });
  return normalizeDescriptor(descriptor);
};

export const releaseReferenceImage = async (assetId) => {
  if (!isUuidV7(assetId)) throw invalidRequest();
  const released = await invokeDesktop('image_blob_release', { assetId });
  if (typeof released !== 'boolean') throw invalidResponse();
  return released;
};

export const selectReferenceImagePlayback = async (projectId) => {
  if (!isUuidV7(projectId)) throw invalidRequest();
  const playback = await invokeDesktop('image_reference_select', {
    request: { projectId },
  });
  return playback === null ? null : normalizeReferencePlayback(playback, projectId);
};

export const releaseReferenceImagePlayback = async ({ playbackId, projectId } = {}) => {
  if (!isUuidVersion(playbackId, 4) || !isUuidV7(projectId)) throw invalidRequest();
  const released = await invokeDesktop('image_reference_playback_release', {
    request: { playbackId, projectId },
  });
  if (typeof released !== 'boolean') throw invalidResponse();
  return released;
};

export const exportReferenceImagePlayback = async (
  playbackUrl,
  projectId,
  suggestedName = 'album-art.png'
) => {
  if (!isUuidV7(projectId)) throw invalidRequest();
  const saved = await invokeDesktop('image_reference_export', {
    request: {
      projectId,
      playbackId: referencePlaybackId(playbackUrl),
      suggestedName: requireSuggestedName(suggestedName),
    },
  });
  if (typeof saved !== 'boolean') throw invalidResponse();
  return saved;
};
