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

const categoryKeys = new Set(CACHE_CATEGORY_KEYS);
const EMPTY_FILES = Object.freeze([]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const hasExactKeys = (value, expectedKeys) => {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => expectedKeys.includes(key));
};

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

const normalizeCommandFailure = (error) => {
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : 'cacheCommandFailed';
  return new CacheServiceError(code, 'The cache operation could not be completed');
};

const requireCategory = (category) => {
  if (!categoryKeys.has(category)) throw invalidRequest();
  return category;
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

const normalizeNativeSnapshot = (snapshot) => {
  if (!isRecord(snapshot)
      || !hasExactKeys(snapshot, ['categories', 'totalCount', 'totalSizeBytes'])
      || !Array.isArray(snapshot.categories)
      || !isSafeCount(snapshot.totalCount)
      || !isSafeCount(snapshot.totalSizeBytes)) {
    throw invalidResponse();
  }

  const details = Object.fromEntries(CACHE_CATEGORY_KEYS.map((key) => [key, emptyCategory()]));
  const seen = new Set();
  let categoryCount = 0;
  let categorySize = 0;

  for (const entry of snapshot.categories) {
    if (!isRecord(entry)
        || !hasExactKeys(entry, ['category', 'count', 'sizeBytes'])
        || !categoryKeys.has(entry.category)
        || seen.has(entry.category)
        || !isSafeCount(entry.count)
        || !isSafeCount(entry.sizeBytes)) {
      throw invalidResponse();
    }
    seen.add(entry.category);
    categoryCount += entry.count;
    categorySize += entry.sizeBytes;
    if (!Number.isSafeInteger(categoryCount) || !Number.isSafeInteger(categorySize)) {
      throw invalidResponse();
    }
    details[entry.category] = categoryDetails(entry.count, entry.sizeBytes);
  }

  // Native totals count distinct artifacts across categories. Legacy CacheTab totals are the sum
  // of its category rows, so shared artifacts can make the legacy total larger but never smaller.
  if (snapshot.totalCount > categoryCount || snapshot.totalSizeBytes > categorySize) {
    throw invalidResponse();
  }

  return Object.freeze({
    details,
    nativeTotalCount: snapshot.totalCount,
    nativeTotalSizeBytes: snapshot.totalSizeBytes,
    legacyTotalCount: categoryCount,
    legacyTotalSizeBytes: categorySize,
  });
};

const toLegacyDetails = (normalized) => Object.freeze({
  ...normalized.details,
  totalCount: normalized.legacyTotalCount,
  totalSize: normalized.legacyTotalSizeBytes,
  formattedTotalSize: formatBytes(normalized.legacyTotalSizeBytes),
});

const normalizeInfoResponse = (snapshot) => Object.freeze({
  success: true,
  details: toLegacyDetails(normalizeNativeSnapshot(snapshot)),
});

const normalizeClearResponse = (response, requestedCategory) => {
  if (!isRecord(response)
      || !hasExactKeys(response, [
        'category',
        'removedCount',
        'removedSizeBytes',
        'retainedSharedCount',
        'leasedCount',
        'cleanupFailedCount',
        'before',
        'after',
      ])
      || response.category !== requestedCategory
      || !isSafeCount(response.removedCount)
      || !isSafeCount(response.removedSizeBytes)
      || !isSafeCount(response.retainedSharedCount)
      || !isSafeCount(response.leasedCount)
      || !isSafeCount(response.cleanupFailedCount)) {
    throw invalidResponse();
  }
  const before = normalizeNativeSnapshot(response.before);
  const after = normalizeNativeSnapshot(response.after);

  const cleared = {};
  for (const key of CACHE_CATEGORY_KEYS) {
    const beforeCategory = before.details[key];
    const afterCategory = after.details[key];
    if (afterCategory.count > beforeCategory.count || afterCategory.size > beforeCategory.size) {
      throw invalidResponse();
    }
    cleared[key] = categoryDetails(
      beforeCategory.count - afterCategory.count,
      beforeCategory.size - afterCategory.size
    );
  }

  if (requestedCategory !== null) {
    return Object.freeze({
      success: true,
      message: `${requestedCategory} cache cleared successfully`,
      details: Object.freeze({ [requestedCategory]: cleared[requestedCategory] }),
    });
  }

  const totalCount = CACHE_CATEGORY_KEYS.reduce((sum, key) => sum + cleared[key].count, 0);
  const totalSize = CACHE_CATEGORY_KEYS.reduce((sum, key) => sum + cleared[key].size, 0);
  return Object.freeze({
    success: true,
    message: 'Cache cleared successfully',
    details: Object.freeze({
      ...cleared,
      totalCount,
      totalSize,
      formattedTotalSize: formatBytes(totalSize),
    }),
  });
};

export const createCacheService = ({ invokeCommand = invokeDesktop } = {}) => {
  const invoke = async (command, args, normalize) => {
    try {
      return normalize(await invokeCommand(command, args));
    } catch (error) {
      if (error instanceof CacheServiceError) throw error;
      throw normalizeCommandFailure(error);
    }
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
