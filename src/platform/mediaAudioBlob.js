// Recorder audio blobs: raw-IPC import into a leased native asset, and its release.
import { invokeDesktop, invokeDesktopRaw } from './desktopRuntime';
import {
  hasControlCharacter,
  invalidMediaRequest,
  invalidMediaResponse,
  isSafePositiveSize,
  isUuidV7,
  normalizeMedia,
  validateAssetId,
} from './mediaDescriptors';
import { hasExactKeys } from './plainDataRecord';

const MAX_AUDIO_BLOB_BYTES = 64 * 1024 * 1024;
const AUDIO_BLOB_MARKER = '__nativeAudioBlob';
const AUDIO_BLOB_DESCRIPTOR_KEYS = Object.freeze([
  AUDIO_BLOB_MARKER,
  'assetId',
  'name',
  'size',
  'type',
]);
const AUDIO_BLOB_FORMATS = Object.freeze({
  'audio/aac': Object.freeze({ mimeType: 'audio/aac', extension: 'aac' }),
  'audio/flac': Object.freeze({ mimeType: 'audio/flac', extension: 'flac' }),
  'audio/mp4': Object.freeze({ mimeType: 'audio/mp4', extension: 'm4a' }),
  'audio/x-m4a': Object.freeze({ mimeType: 'audio/mp4', extension: 'm4a' }),
  'audio/mpeg': Object.freeze({ mimeType: 'audio/mpeg', extension: 'mp3' }),
  'audio/ogg': Object.freeze({ mimeType: 'audio/ogg', extension: 'ogg' }),
  'audio/wav': Object.freeze({ mimeType: 'audio/wav', extension: 'wav' }),
  'audio/wave': Object.freeze({ mimeType: 'audio/wav', extension: 'wav' }),
  'audio/x-wav': Object.freeze({ mimeType: 'audio/wav', extension: 'wav' }),
  'audio/webm': Object.freeze({ mimeType: 'audio/webm', extension: 'weba' }),
});
const AUDIO_CODEC_PARAMETER_PATTERN = /^codecs=(?:aac|mp3|opus|vorbis|mp4a(?:\.[0-9]+){1,2})$/;

const normalizeAudioBlobFormat = (value) => {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 128
      || hasControlCharacter(value)) {
    throw invalidMediaRequest();
  }
  const parts = value.toLowerCase().split(';').map((part) => part.trim());
  if (parts.length > 2 || (parts.length === 2 && !AUDIO_CODEC_PARAMETER_PATTERN.test(parts[1]))) {
    throw invalidMediaRequest();
  }
  const format = AUDIO_BLOB_FORMATS[parts[0]];
  if (!format) throw invalidMediaRequest();
  return format;
};

export const isNativeAudioBlob = (value) => (
  hasExactKeys(value, AUDIO_BLOB_DESCRIPTOR_KEYS)
  && Object.isFrozen(value)
  && value[AUDIO_BLOB_MARKER] === true
  && isUuidV7(value.assetId)
  && typeof value.name === 'string'
  && typeof value.type === 'string'
  && isSafePositiveSize(value.size)
  && (() => {
    try {
      const format = normalizeAudioBlobFormat(value.type);
      return value.name === `recording.${format.extension}`;
    } catch {
      return false;
    }
  })()
);

export const importAudioBlob = async (blob) => {
  if (typeof Blob === 'undefined'
      || !(blob instanceof Blob)
      || !isSafePositiveSize(blob.size)
      || blob.size > MAX_AUDIO_BLOB_BYTES) {
    throw invalidMediaRequest();
  }
  const format = normalizeAudioBlobFormat(blob.type);
  let bytes;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    throw invalidMediaRequest();
  }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== blob.size) {
    throw invalidMediaRequest();
  }

  const response = await invokeDesktopRaw(
    'media_blob_import',
    bytes,
    { 'x-osg-content-type': format.mimeType }
  );
  try {
    if (!hasExactKeys(response, ['asset'])) throw invalidMediaResponse();
    const asset = normalizeMedia(response.asset);
    if (asset.kind !== 'audio'
        || asset.extension !== format.extension
        || asset.displayName !== `recording.${format.extension}`
        || asset.sizeBytes !== blob.size) {
      throw invalidMediaResponse();
    }
    return Object.freeze({
      [AUDIO_BLOB_MARKER]: true,
      assetId: asset.id,
      name: asset.displayName,
      type: format.mimeType,
      size: asset.sizeBytes,
    });
  } catch (error) {
    if (error?.code === 'invalidMediaResponse') throw error;
    throw invalidMediaResponse();
  }
};

export const releaseAudioBlob = async (assetId) => {
  const released = await invokeDesktop('media_blob_release', { assetId: validateAssetId(assetId) });
  if (typeof released !== 'boolean') throw invalidMediaResponse();
  return released;
};
