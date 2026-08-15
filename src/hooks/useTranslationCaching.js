/**
 * Legacy compatibility exports. Active translation hydration/persistence now lives in
 * useTranslationState and the project-owned translation persistence facade.
 */

export const TRANSLATION_CACHE_KEY = 'translated_subtitles_cache';

export const saveTranslationsToCache = () => false;

export const clearTranslationCache = () => {
  try {
    localStorage.removeItem(TRANSLATION_CACHE_KEY);
    return true;
  } catch {
    return false;
  }
};

export const translationCacheMatches = (cacheEntry, mediaId, subtitleHash) => (
  cacheEntry !== null
  && typeof cacheEntry === 'object'
  && !Array.isArray(cacheEntry)
  && cacheEntry.mediaId === mediaId
  && cacheEntry.subtitleHash === subtitleHash
  && Array.isArray(cacheEntry.translations)
  && cacheEntry.translations.length > 0
);

// Deliberately does not hydrate the obsolete global localStorage cache.
export const useTranslationCaching = () => {};
