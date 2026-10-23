// Validation of the native media DTOs: path-free descriptors, playback capabilities and
// candidate envelopes. Pure functions only; IPC lives in the modules that import these.
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { hasExactKeys, isRecord } from './plainDataRecord';
import { exactRecord } from './nativeDataSnapshot';

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
export const MEDIA_KEYS = Object.freeze(['displayName', 'extension', 'id', 'kind', 'sizeBytes']);
const PLAYBACK_KEYS = Object.freeze(['byteLength', 'id', 'mimeType', 'playbackUrl']);
const CONTENT_IDENTITY_KEYS = Object.freeze(['algorithm', 'digest', 'sizeBytes']);
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

const isUuidVersion = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expectedVersion;
  } catch {
    return false;
  }
};

export const isUuidV7 = (value) => isUuidVersion(value, 7);
const isUuidV4 = (value) => isUuidVersion(value, 4);

export const hasControlCharacter = (value) => Array.from(value).some((character) => {
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

export const isSafePositiveSize = (value) => Number.isSafeInteger(value) && value > 0;

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

export const invalidMediaRequest = () => {
  const error = new Error('The native media request is invalid');
  error.name = 'MediaServiceError';
  error.code = 'invalidMediaRequest';
  return error;
};

export const invalidMediaResponse = () => {
  const error = new Error('The desktop host returned invalid media metadata');
  error.name = 'MediaServiceError';
  error.code = 'invalidMediaResponse';
  return error;
};

export const validateAssetId = (value) => {
  if (!isUuidV7(value)) throw invalidMediaRequest();
  return value;
};

export const validatePlaybackId = (value) => {
  if (!isUuidV4(value)) throw invalidMediaRequest();
  return value;
};

export const validateOfferId = (value) => {
  if (!isUuidV4(value)) throw invalidMediaRequest();
  return value;
};


export const normalizeMedia = (media) => {
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

export const normalizeMediaCandidate = (value) => {
  const candidate = exactRecord(
    value,
    ['asset', 'contentIdentity'],
    invalidMediaResponse
  );
  const assetSnapshot = exactRecord(candidate.asset, MEDIA_KEYS, invalidMediaResponse);
  const identity = exactRecord(
    candidate.contentIdentity,
    CONTENT_IDENTITY_KEYS,
    invalidMediaResponse
  );
  const asset = normalizeMedia(assetSnapshot);
  if (identity.algorithm !== 'blake3-256'
      || typeof identity.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(identity.digest)
      || identity.sizeBytes !== asset.sizeBytes) {
    throw invalidMediaResponse();
  }
  return Object.freeze({
    asset: Object.freeze({
      displayName: asset.displayName,
      extension: asset.extension,
      id: asset.id,
      kind: asset.kind,
      sizeBytes: asset.sizeBytes,
    }),
    contentIdentity: Object.freeze({
      algorithm: identity.algorithm,
      digest: identity.digest,
      sizeBytes: identity.sizeBytes,
    }),
  });
};

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

export const normalizeSnapshot = (snapshot, { requireMedia = false, requireEmpty = false } = {}) => {
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
