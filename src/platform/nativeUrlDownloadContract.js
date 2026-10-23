import { DOWNLOAD_COOKIE_SOURCES } from './downloadCookiePreference';

/**
 * The fixed wire vocabulary of a native URL download: the failures it may raise, the caller request
 * shape it accepts, and the projection of native events. Every value crossing this boundary is
 * snapshotted by property descriptor, so a hostile accessor, proxy trap or prototype can never be
 * invoked while validating it.
 */

const MAX_PREFERRED_SUBTITLE_LANGUAGES = 32;
const MAX_URL_CHARACTERS = 8_192;
const MIN_QUALITY_HEIGHT = 144;
const MAX_QUALITY_HEIGHT = 4_320;
const cookieSources = new Set(DOWNLOAD_COOKIE_SOURCES);
const requestKeys = Object.freeze([
  'url',
  'cookieSource',
  'onStarted',
  'onProgress',
  'onSubtitle',
  'preferredSubtitleLanguages',
  'quality',
  'signal',
  'validateOwnership',
  'admitActivation',
  'publishActivation',
  'rollbackActivation',
]);

export const fixedFailure = (code = 'nativeDownloadFailed') => {
  const error = new Error('The native media download could not be completed');
  error.name = 'NativeUrlDownloadError';
  error.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code)
    ? code
    : 'nativeDownloadFailed';
  return error;
};

export const abortedFailure = () => {
  const error = new Error('The native media download was cancelled');
  error.name = 'AbortError';
  error.code = 'nativeDownloadAborted';
  return error;
};

export const progressPercent = (event) => {
  const basisPoints = event.job.progress.basisPoints;
  const percent = Math.round(basisPoints / 100);
  return Math.max(0, Math.min(100, percent));
};

export const normalizePreferredLanguages = (languages) => {
  if (languages === undefined) return Object.freeze([]);
  let values;
  try {
    if (!Array.isArray(languages)) throw fixedFailure('invalidDownloadRequest');
    const descriptors = Object.getOwnPropertyDescriptors(languages);
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value')
        || !Number.isSafeInteger(length.value)
        || length.value < 0 || length.value > MAX_PREFERRED_SUBTITLE_LANGUAGES
        || Reflect.ownKeys(descriptors).length !== length.value + 1) {
      throw fixedFailure('invalidDownloadRequest');
    }
    values = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw fixedFailure('invalidDownloadRequest');
      }
      values.push(descriptor.value);
    }
  } catch {
    throw fixedFailure('invalidDownloadRequest');
  }
  const normalized = values.map((language) => {
    if (typeof language !== 'string' || !/^[A-Za-z0-9._-]{1,35}$/.test(language)) {
      throw fixedFailure('invalidDownloadRequest');
    }
    return language.toLowerCase();
  });
  return Object.freeze([...new Set(normalized)]);
};

export const snapshotDownloadRequest = (request) => {
  try {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const prototype = Object.getPrototypeOf(request);
    if (prototype !== Object.prototype && prototype !== null) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const descriptors = Object.getOwnPropertyDescriptors(request);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !requestKeys.includes(key))
        || !Object.hasOwn(descriptors, 'url')
        || !Object.hasOwn(descriptors, 'cookieSource')) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const snapshot = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw fixedFailure('invalidDownloadRequest');
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw fixedFailure('invalidDownloadRequest');
  }
};

export const normalizeUrl = (url) => {
  if (typeof url !== 'string'
      || url.length === 0
      || url.length > MAX_URL_CHARACTERS
      || url.includes('\\')
      || Array.from(url).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
      })) {
    throw fixedFailure('invalidDownloadRequest');
  }
  return url;
};

export const snapshotSignal = (signal) => {
  if (signal === undefined) return null;
  try {
    if (signal === null || (typeof signal !== 'object' && typeof signal !== 'function')) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const add = Reflect.get(signal, 'addEventListener');
    const remove = Reflect.get(signal, 'removeEventListener');
    if (typeof add !== 'function' || typeof remove !== 'function') {
      throw fixedFailure('invalidDownloadRequest');
    }
    return Object.freeze({ add, remove, target: signal });
  } catch {
    throw fixedFailure('invalidDownloadRequest');
  }
};

export const normalizeCallback = (callback) => {
  if (callback !== undefined && typeof callback !== 'function') {
    throw fixedFailure('invalidDownloadRequest');
  }
  return callback;
};

export const normalizeCookieSource = (cookieSource) => {
  if (typeof cookieSource !== 'string' || !cookieSources.has(cookieSource)) {
    throw fixedFailure('invalidDownloadRequest');
  }
  return cookieSource;
};

/**
 * An explicit video quality (`'720p'`) requested by a quality re-download, or null for the default
 * best-quality download. Bounded to the heights the native download contract accepts.
 */
export const normalizeQuality = (quality) => {
  if (quality === undefined || quality === null) return null;
  const match = typeof quality === 'string' ? /^([1-9][0-9]{2,3})p$/.exec(quality) : null;
  const height = match === null ? NaN : Number(match[1]);
  if (!(height >= MIN_QUALITY_HEIGHT && height <= MAX_QUALITY_HEIGHT)) {
    throw fixedFailure('invalidDownloadRequest');
  }
  return quality;
};

/** Prefer an exact inventory format at the requested height (combined audio first, then the higher
 * bitrate); otherwise ask the host for the best format at most that tall. */
export const selectNativeQuality = (inventory, quality) => {
  const height = Number.parseInt(String(quality), 10);
  const formats = Array.isArray(inventory?.formats?.video) ? inventory.formats.video : [];
  const format = formats
    .filter((candidate) => candidate.height === height)
    .sort((left, right) => {
      if (left.includesAudio !== right.includesAudio) return left.includesAudio ? -1 : 1;
      return (right.bitrateKbps ?? 0) - (left.bitrateKbps ?? 0);
    })[0];
  if (format) return { mode: 'exact', formatId: format.formatId };
  if (Number.isInteger(height) && height >= MIN_QUALITY_HEIGHT && height <= MAX_QUALITY_HEIGHT) {
    return { mode: 'atMost', height };
  }
  throw new Error('The selected video quality is invalid');
};

export const selectSubtitle = (inventory, preferredLanguages) => {
  if (preferredLanguages.length === 0 || !Array.isArray(inventory?.subtitles)) return null;
  for (const preferred of preferredLanguages) {
    const preferredBase = preferred.split('-')[0];
    const candidates = inventory.subtitles.filter(({ language }) => {
      const normalized = language.toLowerCase();
      return normalized === preferred
        || normalized.split('-')[0] === preferredBase;
    });
    candidates.sort((left, right) => {
      if (left.source === right.source) return 0;
      return left.source === 'manual' ? -1 : 1;
    });
    if (candidates[0]) {
      return Object.freeze({
        language: candidates[0].language,
        source: candidates[0].source,
      });
    }
  }
  return null;
};

export const candidateAssetId = (candidate) => {
  try {
    const candidateDescriptors = Object.getOwnPropertyDescriptors(candidate);
    const asset = candidateDescriptors.asset;
    if (!asset || !Object.hasOwn(asset, 'value')
        || asset.value === null || typeof asset.value !== 'object') {
      throw fixedFailure('invalidDownloadResponse');
    }
    const assetDescriptors = Object.getOwnPropertyDescriptors(asset.value);
    const id = assetDescriptors.id;
    if (!id || !Object.hasOwn(id, 'value') || typeof id.value !== 'string') {
      throw fixedFailure('invalidDownloadResponse');
    }
    return id.value;
  } catch {
    throw fixedFailure('invalidDownloadResponse');
  }
};
