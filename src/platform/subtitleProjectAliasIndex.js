// The subtitle cache alias index: cache-ID validation, the store's error type, and normalization
// of the persisted cacheId -> projectId index that the desktop host returns.
import { isUuidV7 } from './projectSnapshotAdapter';

export const SUBTITLE_CACHE_TRACK_LABEL = 'Cached subtitles';
export const MAX_SUBTITLE_PROJECT_ALIASES = 2_048;
const MAX_SUBTITLE_PROJECT_INDEX_BYTES = 900 * 1024;

const INDEX_SCHEMA_VERSION = 1;

const isControlCharacter = character => /\p{Cc}/u.test(character);

export class SubtitleProjectStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SubtitleProjectStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const validateCacheId = (cacheId) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0 || cacheId.length > 8_192
      || Array.from(cacheId).some(isControlCharacter)) {
    throw new SubtitleProjectStoreError('invalidCacheId', 'A bounded subtitle cache ID is required');
  }
  return cacheId;
};

export const projectNameForCache = (cacheId) => {
  const cleaned = Array.from(cacheId, (character) => (
    isControlCharacter(character) ? ' ' : character
  )).join('').trim();
  const name = Array.from(cleaned).slice(0, 200).join('').trim();
  return name || 'Subtitles';
};

const emptyIndex = () => ({
  schemaVersion: INDEX_SCHEMA_VERSION,
  activeCacheId: null,
  entries: [],
});

const parseSerializedIndex = (value) => {
  if (typeof value !== 'string' || value.length === 0
      || value.length > MAX_SUBTITLE_PROJECT_INDEX_BYTES) {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const normalizeIndex = (rawValue) => {
  const value = parseSerializedIndex(rawValue);
  if (!value || value.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    return emptyIndex();
  }

  const entries = [];
  const seenCacheIds = new Set();
  const seenProjectIds = new Set();
  value.entries.forEach((entry) => {
    if (!entry || typeof entry.cacheId !== 'string' || entry.cacheId.length === 0
        || entry.cacheId.length > 8_192 || Array.from(entry.cacheId).some(isControlCharacter)
        || !isUuidV7(entry.projectId)
        || !Number.isSafeInteger(entry.lastOpenedAt) || entry.lastOpenedAt < 0
        || seenCacheIds.has(entry.cacheId) || seenProjectIds.has(entry.projectId)) {
      return;
    }
    seenCacheIds.add(entry.cacheId);
    seenProjectIds.add(entry.projectId);
    entries.push({
      cacheId: entry.cacheId,
      projectId: entry.projectId,
      lastOpenedAt: entry.lastOpenedAt,
    });
  });

  entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
  const bounded = entries.slice(0, MAX_SUBTITLE_PROJECT_ALIASES);
  const activeCacheId = typeof value.activeCacheId === 'string'
      && bounded.some((entry) => entry.cacheId === value.activeCacheId)
    ? value.activeCacheId
    : null;
  return { schemaVersion: INDEX_SCHEMA_VERSION, activeCacheId, entries: bounded };
};
