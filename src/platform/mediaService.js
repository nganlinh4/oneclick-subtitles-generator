import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop, invokeDesktopRaw } from './desktopRuntime';

const NATIVE_MEDIA_MARKER = '__nativeMedia';
const MAX_DISPLAY_NAME_CHARACTERS = 512;
const AUDIO_EXTENSIONS = new Set([
  'aac', 'ac3', 'aiff', 'amr', 'ape', 'au', 'caf', 'dts', 'flac', 'm4a', 'mka', 'mp3',
  'oga', 'ogg', 'opus', 'ra', 'wav', 'wma',
  'weba',
]);
const VIDEO_EXTENSIONS = new Set([
  '3gp', '3gpp', 'avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv',
]);
const SNAPSHOT_KEYS = Object.freeze(['media', 'playback', 'subtitleTrack']);
const MEDIA_KEYS = Object.freeze(['displayName', 'extension', 'id', 'kind', 'sizeBytes']);
const PLAYBACK_KEYS = Object.freeze(['byteLength', 'id', 'mimeType', 'playbackUrl']);
const DESCRIPTOR_KEYS = Object.freeze([
  NATIVE_MEDIA_MARKER,
  'assetId',
  'lastModified',
  'name',
  'playbackId',
  'playbackUrl',
  'size',
  'type',
]);
const PLAYBACK_URL_PATTERN = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\?token=([0-9a-f]{64})$/i;
const MIME_TYPE_PATTERN = /^(audio|video)\/[a-z0-9][a-z0-9.+-]{0,126}$/;
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

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const hasExactKeys = (value, expectedKeys) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
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
const isUuidV4 = (value) => isUuidVersion(value, 4);

const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});

const expectedKindForExtension = (extension) => {
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
};

const isDisplayName = (value, extension) => (
  typeof value === 'string'
  && value === value.trim()
  && value.length > 0
  && Array.from(value).length <= MAX_DISPLAY_NAME_CHARACTERS
  && !hasControlCharacter(value)
  && !value.includes('/')
  && !value.includes('\\')
  && value.toLowerCase().endsWith(`.${extension}`)
);

const isSafePositiveSize = (value) => Number.isSafeInteger(value) && value > 0;

const parsePlaybackUrl = (value) => {
  if (typeof value !== 'string') return null;
  const match = PLAYBACK_URL_PATTERN.exec(value);
  if (!match) return null;

  const [, portText, playbackId, token] = match;
  const port = Number(portText);
  if (!Number.isInteger(port)
      || port < 1
      || port > 65535
      || String(port) !== portText
      || !isUuidV4(playbackId)
      || token.length !== 64) {
    return null;
  }

  return { playbackId };
};

export const isNativeMediaPlaybackUrl = (value, expectedPlaybackId = null) => {
  const parsed = parsePlaybackUrl(value);
  if (!parsed) return false;
  return expectedPlaybackId === null
    || (isUuidV4(expectedPlaybackId) && parsed.playbackId === expectedPlaybackId);
};

const invalidMediaRequest = () => {
  const error = new Error('The native media request is invalid');
  error.name = 'MediaServiceError';
  error.code = 'invalidMediaRequest';
  return error;
};

const invalidMediaResponse = () => {
  const error = new Error('The desktop host returned invalid media metadata');
  error.name = 'MediaServiceError';
  error.code = 'invalidMediaResponse';
  return error;
};

const validateAssetId = (value) => {
  if (!isUuidV7(value)) throw invalidMediaRequest();
  return value;
};

const validateOfferId = (value) => {
  if (!isUuidV4(value)) throw invalidMediaRequest();
  return value;
};

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

const normalizeMedia = (media) => {
  if (!hasExactKeys(media, MEDIA_KEYS)
      || !isUuidV7(media.id)
      || typeof media.extension !== 'string'
      || !/^[a-z0-9]{1,16}$/.test(media.extension)
      || expectedKindForExtension(media.extension) !== media.kind
      || !isDisplayName(media.displayName, media.extension)
      || !isSafePositiveSize(media.sizeBytes)) {
    throw invalidMediaResponse();
  }
  return media;
};

const normalizePlayback = (playback, media) => {
  if (!hasExactKeys(playback, PLAYBACK_KEYS)
      || !isUuidV4(playback.id)
      || !isNativeMediaPlaybackUrl(playback.playbackUrl, playback.id)
      || !isSafePositiveSize(playback.byteLength)
      || playback.byteLength !== media.sizeBytes
      || typeof playback.mimeType !== 'string') {
    throw invalidMediaResponse();
  }

  const mimeMatch = MIME_TYPE_PATTERN.exec(playback.mimeType);
  if (!mimeMatch || mimeMatch[1] !== media.kind) throw invalidMediaResponse();
  return playback;
};

const createDescriptor = (media, playback) => Object.freeze({
  [NATIVE_MEDIA_MARKER]: true,
  assetId: media.id,
  playbackId: playback.id,
  name: media.displayName,
  type: playback.mimeType,
  size: media.sizeBytes,
  lastModified: 0,
  playbackUrl: playback.playbackUrl,
});

export const createNativeMediaDescriptor = (value) => {
  try {
    if (!hasExactKeys(value, ['asset', 'playback'])) throw invalidMediaResponse();
    const media = normalizeMedia(value.asset);
    const playback = normalizePlayback(value.playback, media);
    return createDescriptor(media, playback);
  } catch (error) {
    if (error?.code === 'invalidMediaResponse') throw error;
    throw invalidMediaResponse();
  }
};

const normalizeSnapshot = (snapshot, { requireMedia = false, requireEmpty = false } = {}) => {
  try {
    if (!hasExactKeys(snapshot, SNAPSHOT_KEYS)
        || (snapshot.subtitleTrack !== null && !isRecord(snapshot.subtitleTrack))) {
      throw invalidMediaResponse();
    }

    const isEmpty = snapshot.media === null && snapshot.playback === null;
    if (isEmpty) {
      if (requireMedia) throw invalidMediaResponse();
      return null;
    }
    if (requireEmpty || snapshot.media === null || snapshot.playback === null) {
      throw invalidMediaResponse();
    }

    const media = normalizeMedia(snapshot.media);
    const playback = normalizePlayback(snapshot.playback, media);
    return createDescriptor(media, playback);
  } catch (error) {
    if (error?.code === 'invalidMediaResponse') throw error;
    throw invalidMediaResponse();
  }
};

export const isNativeMediaDescriptor = (value) => {
  try {
    if (!hasExactKeys(value, DESCRIPTOR_KEYS)
        || !Object.isFrozen(value)
        || value[NATIVE_MEDIA_MARKER] !== true
        || !isUuidV7(value.assetId)
        || !isUuidV4(value.playbackId)
        || value.lastModified !== 0
        || !isSafePositiveSize(value.size)
        || typeof value.name !== 'string'
        || typeof value.type !== 'string'
        || !isNativeMediaPlaybackUrl(value.playbackUrl, value.playbackId)) {
      return false;
    }

    const dotIndex = value.name.lastIndexOf('.');
    if (dotIndex < 0) return false;
    const extension = value.name.slice(dotIndex + 1).toLowerCase();
    const kind = expectedKindForExtension(extension);
    return kind !== null
      && isDisplayName(value.name, extension)
      && MIME_TYPE_PATTERN.test(value.type)
      && value.type.startsWith(`${kind}/`);
  } catch {
    return false;
  }
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

export const selectMedia = async () => {
  const snapshot = await invokeDesktop('select_media', {});
  return snapshot === null ? null : normalizeSnapshot(snapshot);
};

export const getSelectedMedia = async () => normalizeSnapshot(
  await invokeDesktop('get_session_snapshot', {})
);

export const openMediaAsset = async (assetId) => normalizeSnapshot(
  await invokeDesktop('open_media_asset', { id: validateAssetId(assetId) }),
  { requireMedia: true }
);

export const clearMedia = async () => normalizeSnapshot(
  await invokeDesktop('clear_media', {}),
  { requireEmpty: true }
);

export const claimMediaDrop = async (offerId) => normalizeSnapshot(
  await invokeDesktop('media_drop_claim', { offerId: validateOfferId(offerId) }),
  { requireMedia: true }
);
