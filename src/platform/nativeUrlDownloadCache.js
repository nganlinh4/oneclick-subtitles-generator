import { utf8ByteLength } from './plainDataRecord';
const MAX_COMPLETED_ASSETS = 32;
const MAX_COMPLETED_ASSET_BYTES = 16 * 1024 * 1024;

// A hostile subtitle is charged more than the whole budget so it can never be cached.
const subtitleByteLength = (subtitle) => {
  if (subtitle === null) return 0;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(subtitle);
    return ['filename', 'language', 'content'].reduce((total, key) => {
      const descriptor = descriptors[key];
      return total + (descriptor && Object.hasOwn(descriptor, 'value')
        && typeof descriptor.value === 'string'
        ? utf8ByteLength(descriptor.value)
        : 0);
    }, 0);
  } catch {
    return MAX_COMPLETED_ASSET_BYTES + 1;
  }
};

/**
 * In-memory capability cache for assets this adapter already downloaded, keyed by operation. It
 * holds opaque asset IDs and replayable subtitle content only — never paths or native handles — and
 * is bounded by both entry count and accounted bytes so a hostile subtitle cannot grow it.
 */
export const createCompletedAssetCache = () => {
  const entries = new Map();
  let cachedBytes = 0;

  const forget = (key) => {
    const completed = entries.get(key);
    if (completed === undefined) return;
    entries.delete(key);
    cachedBytes -= completed.cacheBytes;
  };

  const remember = (key, assetId, subtitle) => {
    forget(key);
    const cacheBytes = utf8ByteLength(key)
      + utf8ByteLength(assetId)
      + subtitleByteLength(subtitle);
    if (cacheBytes > MAX_COMPLETED_ASSET_BYTES) return;
    entries.set(key, Object.freeze({ assetId, subtitle, cacheBytes }));
    cachedBytes += cacheBytes;
    while (entries.size > MAX_COMPLETED_ASSETS || cachedBytes > MAX_COMPLETED_ASSET_BYTES) {
      forget(entries.keys().next().value);
    }
  };

  // Reading refreshes recency, so the least recently reused capability is evicted first.
  const read = (key) => {
    const completed = entries.get(key);
    if (completed === undefined) return undefined;
    entries.delete(key);
    entries.set(key, completed);
    return completed;
  };

  return Object.freeze({ forget, read, remember });
};
