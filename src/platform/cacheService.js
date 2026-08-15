import { invokeDesktop } from './desktopRuntime';

export const CACHE_CATEGORY_KEYS = Object.freeze([
  'subtitles',
  'videos',
  'userSubtitles',
  'rules',
  'narrationReference',
  'narrationOutput',
  'lyrics',
  'albumArt',
  'uploads',
  'output',
  'videoRendered',
  'videoTemp',
  'videoAlbumArt',
  'videoRendererUploads',
  'videoRendererOutput',
]);

const MAX_NATIVE_CACHE_CATEGORIES = 100_000;
const CACHE_CATEGORY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const cacheCommandCodes = new Set([
  'internal',
  'database',
  'invalidCacheRequest',
  'cacheLimit',
  'cacheKeyConflict',
  'cacheLeaseLimit',
  'artifactStorage',
  'artifactDataCorrupt',
  'invalidArtifactRequest',
  'artifactMetadataTooLarge',
  'artifactLimit',
  'artifactNotFound',
  'artifactContentMismatch',
  'artifactConflict',
  'artifactStateConflict',
  'artifactNotReady',
  'invalidMediaLocation',
]);
const EMPTY_FILES = Object.freeze([]);

const isSafeCount = (value) => Number.isSafeInteger(value) && value >= 0;

export class CacheServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CacheServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new CacheServiceError(
  'invalidCacheRequest',
  'The cache request is invalid'
);

const invalidResponse = () => new CacheServiceError(
  'invalidCacheResponse',
  'The desktop host returned invalid cache metadata'
);

const snapshotDataRecord = (value, expectedKeys, failure) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== expectedKeys.length
        || keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))) {
      throw failure();
    }
    const snapshot = {};
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw failure();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw failure();
  }
};

const snapshotDataArray = (value, maximum, failure) => {
  try {
    if (!Array.isArray(value)) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) {
      throw failure();
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length + 1) throw failure();
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw failure();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw failure();
  }
};

const normalizeCommandFailure = (error) => {
  let code = 'cacheCommandFailed';
  try {
    const candidate = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error.code
      : null;
    if (cacheCommandCodes.has(candidate)) code = candidate;
  } catch {
    // A hostile transport accessor is not authoritative error metadata.
  }
  return new CacheServiceError(code, 'The cache operation could not be completed');
};

const requireCategory = (category) => {
  if (typeof category !== 'string' || !CACHE_CATEGORY_PATTERN.test(category)) {
    throw invalidRequest();
  }
  return category;
};

const isCacheCategory = (category) => (
  typeof category === 'string' && CACHE_CATEGORY_PATTERN.test(category)
);

const defineOwn = (target, key, value) => {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
};

const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = Number((bytes / (1024 ** index)).toFixed(2));
  return `${value} ${units[index]}`;
};

const emptyCategory = () => Object.freeze({
  count: 0,
  size: 0,
  files: EMPTY_FILES,
  formattedSize: '0 Bytes',
});

const categoryDetails = (count, size) => Object.freeze({
  count,
  size,
  files: EMPTY_FILES,
  formattedSize: formatBytes(size),
});

const categoryFrom = (details, category) => (
  Object.hasOwn(details, category) ? details[category] : emptyCategory()
);

const normalizeNativeSnapshot = (snapshot) => {
  const data = snapshotDataRecord(
    snapshot,
    ['categories', 'totalCount', 'totalSizeBytes'],
    invalidResponse
  );
  const categories = snapshotDataArray(
    data.categories,
    MAX_NATIVE_CACHE_CATEGORIES,
    invalidResponse
  );
  if (!isSafeCount(data.totalCount) || !isSafeCount(data.totalSizeBytes)) {
    throw invalidResponse();
  }

  const details = {};
  const categoryOrder = [...CACHE_CATEGORY_KEYS];
  for (const key of CACHE_CATEGORY_KEYS) defineOwn(details, key, emptyCategory());
  const seen = new Set();
  let categoryCount = 0;
  let categorySize = 0;

  for (const rawEntry of categories) {
    const entry = snapshotDataRecord(
      rawEntry,
      ['category', 'count', 'sizeBytes'],
      invalidResponse
    );
    if (!isCacheCategory(entry.category)
        || seen.has(entry.category)
        || !isSafeCount(entry.count) || !isSafeCount(entry.sizeBytes)) {
      throw invalidResponse();
    }
    seen.add(entry.category);
    categoryCount += entry.count;
    categorySize += entry.sizeBytes;
    if (!Number.isSafeInteger(categoryCount) || !Number.isSafeInteger(categorySize)) {
      throw invalidResponse();
    }
    if (!Object.hasOwn(details, entry.category)) categoryOrder.push(entry.category);
    defineOwn(details, entry.category, categoryDetails(entry.count, entry.sizeBytes));
  }

  // Native totals count distinct artifacts across categories. Legacy CacheTab totals are the sum
  // of its category rows, so shared artifacts can make the legacy total larger but never smaller.
  if (data.totalCount > categoryCount || data.totalSizeBytes > categorySize) {
    throw invalidResponse();
  }

  return Object.freeze({
    details: Object.freeze(details),
    categoryOrder: Object.freeze(categoryOrder),
    nativeTotalCount: data.totalCount,
    nativeTotalSizeBytes: data.totalSizeBytes,
    legacyTotalCount: categoryCount,
    legacyTotalSizeBytes: categorySize,
  });
};

const toLegacyDetails = (normalized) => {
  const details = {};
  for (const key of normalized.categoryOrder) defineOwn(details, key, normalized.details[key]);
  defineOwn(details, 'totalCount', normalized.legacyTotalCount);
  defineOwn(details, 'totalSize', normalized.legacyTotalSizeBytes);
  defineOwn(details, 'formattedTotalSize', formatBytes(normalized.legacyTotalSizeBytes));
  return Object.freeze(details);
};

const normalizeInfoResponse = (snapshot) => Object.freeze({
  success: true,
  details: toLegacyDetails(normalizeNativeSnapshot(snapshot)),
});

const normalizeClearResponse = (response, requestedCategory) => {
  const data = snapshotDataRecord(response, [
        'category',
        'removedCount',
        'removedSizeBytes',
        'retainedSharedCount',
        'leasedCount',
        'cleanupFailedCount',
        'before',
        'after',
      ], invalidResponse);
  if (data.category !== requestedCategory
      || !isSafeCount(data.removedCount)
      || !isSafeCount(data.removedSizeBytes)
      || !isSafeCount(data.retainedSharedCount)
      || !isSafeCount(data.leasedCount)
      || !isSafeCount(data.cleanupFailedCount)) {
    throw invalidResponse();
  }
  const before = normalizeNativeSnapshot(data.before);
  const after = normalizeNativeSnapshot(data.after);
  const beforeRequested = requestedCategory === null
    ? null
    : categoryFrom(before.details, requestedCategory);
  const scopedBeforeCount = requestedCategory === null
    ? before.legacyTotalCount
    : beforeRequested.count;
  const scopedBeforeSize = requestedCategory === null
    ? before.nativeTotalSizeBytes
    : beforeRequested.size;
  const candidateOutcomeCount = data.removedCount
    + data.retainedSharedCount
    + data.cleanupFailedCount;
  if (!Number.isSafeInteger(candidateOutcomeCount)
      || candidateOutcomeCount > scopedBeforeCount
      || data.removedSizeBytes > scopedBeforeSize
      || after.nativeTotalCount > before.nativeTotalCount
      || after.nativeTotalSizeBytes > before.nativeTotalSizeBytes) {
    throw invalidResponse();
  }

  const cleared = {};
  const categoryOrder = [...before.categoryOrder];
  for (const key of after.categoryOrder) {
    if (!Object.hasOwn(before.details, key)) categoryOrder.push(key);
  }
  for (const key of categoryOrder) {
    const beforeCategory = categoryFrom(before.details, key);
    const afterCategory = categoryFrom(after.details, key);
    if (afterCategory.count > beforeCategory.count || afterCategory.size > beforeCategory.size) {
      throw invalidResponse();
    }
    defineOwn(cleared, key, categoryDetails(
      beforeCategory.count - afterCategory.count,
      beforeCategory.size - afterCategory.size
    ));
  }

  if (requestedCategory !== null) {
    const details = {};
    defineOwn(details, requestedCategory, categoryFrom(cleared, requestedCategory));
    return Object.freeze({
      success: true,
      message: `${requestedCategory} cache cleared successfully`,
      details: Object.freeze(details),
    });
  }

  const totalCount = categoryOrder.reduce((sum, key) => sum + cleared[key].count, 0);
  const totalSize = categoryOrder.reduce((sum, key) => sum + cleared[key].size, 0);
  const details = {};
  for (const key of categoryOrder) defineOwn(details, key, cleared[key]);
  defineOwn(details, 'totalCount', totalCount);
  defineOwn(details, 'totalSize', totalSize);
  defineOwn(details, 'formattedTotalSize', formatBytes(totalSize));
  return Object.freeze({
    success: true,
    message: 'Cache cleared successfully',
    details: Object.freeze(details),
  });
};

export const createCacheService = ({ invokeCommand = invokeDesktop } = {}) => {
  const invoke = async (command, args, normalize) => {
    let result;
    try {
      result = await invokeCommand(command, args);
    } catch (error) {
      throw normalizeCommandFailure(error);
    }
    return normalize(result);
  };

  return Object.freeze({
    getCacheInfo: () => invoke('cache_info', {}, normalizeInfoResponse),
    clearCache: async (category = null) => {
      const normalizedCategory = category === null ? null : requireCategory(category);
      return invoke(
        'cache_clear',
        { category: normalizedCategory },
        (response) => normalizeClearResponse(response, normalizedCategory)
      );
    },
    pruneExpiredCache: () => invoke('cache_prune_expired', {}, normalizeInfoResponse),
  });
};

const cacheService = createCacheService();

export const getCacheInfo = cacheService.getCacheInfo;
export const clearCache = cacheService.clearCache;
export const pruneExpiredCache = cacheService.pruneExpiredCache;

export { formatBytes as formatCacheBytes };
