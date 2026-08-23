const STORAGE_KEY = 'uploaded_srt_info';
const SCHEMA_VERSION = 2;
const MAX_FILE_NAME_CHARACTERS = 512;
const MAX_CACHE_ID_CHARACTERS = 8_192;
const SERIALIZED_LIMIT = 12_000;
const EXACT_KEYS = Object.freeze(['cacheId', 'fileName', 'v']);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});

const isSafeFileName = (value) => (
  typeof value === 'string'
  && value === value.trim()
  && Array.from(value).length > 0
  && Array.from(value).length <= MAX_FILE_NAME_CHARACTERS
  && !hasControlCharacter(value)
  && !value.includes('/')
  && !value.includes('\\')
  && /\.(?:srt|json)$/i.test(value)
);

const isSafeCacheId = (value) => (
  value === null
  || (typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CACHE_ID_CHARACTERS
    && !hasControlCharacter(value))
);

const sameKeys = (value) => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === EXACT_KEYS.length
    && keys.every((key, index) => key === EXACT_KEYS[index]);
};

const defaultStorage = () => globalThis.localStorage;

export const readSubtitleImportProvenance = ({ storage = defaultStorage() } = {}) => {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > SERIALIZED_LIMIT) return null;
    const parsed = JSON.parse(raw);
    if (!sameKeys(parsed)
        || parsed.v !== SCHEMA_VERSION
        || !isSafeCacheId(parsed.cacheId)
        || !isSafeFileName(parsed.fileName)) {
      return null;
    }
    return Object.freeze({ cacheId: parsed.cacheId, fileName: parsed.fileName });
  } catch {
    return null;
  }
};

export const writeSubtitleImportProvenance = ({ cacheId = null, fileName }, {
  storage = defaultStorage(),
} = {}) => {
  if (!isSafeCacheId(cacheId) || !isSafeFileName(fileName)) {
    throw new TypeError('A safe subtitle import identity is required');
  }
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      v: SCHEMA_VERSION,
      cacheId,
      fileName,
    }));
    return true;
  } catch {
    return false;
  }
};

export const bindPendingSubtitleImportProvenance = (cacheId, options = {}) => {
  if (!isSafeCacheId(cacheId) || cacheId === null) return null;
  const current = readSubtitleImportProvenance(options);
  if (current === null) return null;
  if (current.cacheId === cacheId) return current;
  if (current.cacheId !== null) return null;
  if (!writeSubtitleImportProvenance({ cacheId, fileName: current.fileName }, options)) return null;
  return Object.freeze({ cacheId, fileName: current.fileName });
};

export const clearSubtitleImportProvenance = ({ expectedCacheId, storage = defaultStorage() } = {}) => {
  if (!storage || typeof storage.removeItem !== 'function') return false;
  if (expectedCacheId !== undefined) {
    const current = readSubtitleImportProvenance({ storage });
    if (current === null || current.cacheId !== expectedCacheId) return false;
  }
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};

export const subtitleImportFileNameForCache = (cacheId, options = {}) => {
  const current = readSubtitleImportProvenance(options);
  return current !== null && current.cacheId === cacheId ? current.fileName : '';
};

export const SUBTITLE_IMPORT_PROVENANCE_KEY = STORAGE_KEY;
