/**
 * Store for user-provided subtitles
 * This file is used to manage user-provided subtitles and persist them for the current video
 */

import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';

// Store user-provided subtitles globally
let globalUserSubtitles = null;

// Current cache ID for the video being processed
let currentCacheId = null;
const currentCacheIdListeners = new Set();

export const subscribeCurrentCacheId = (listener) => {
  if (typeof listener !== 'function') {
    throw new TypeError('A current subtitle cache listener is required');
  }
  currentCacheIdListeners.add(listener);
  return () => currentCacheIdListeners.delete(listener);
};

const publishCurrentCacheId = (cacheId, previousCacheId) => {
  currentCacheIdListeners.forEach((listener) => {
    try {
      listener(cacheId, previousCacheId);
    } catch (error) {
      console.error('Current subtitle cache listener failed:', error);
    }
  });
};

const publishUserSubtitles = (subtitlesText) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('userProvidedSubtitlesUpdated', {
      detail: { subtitlesText: subtitlesText || '' }
    }));
  }
};

const hydrateProjectSubtitles = async (cacheId) => {
  try {
    const auxiliary = await readProjectAuxiliary(cacheId);
    if (currentCacheId !== cacheId) return;
    globalUserSubtitles = auxiliary?.userSubtitles ?? null;
    publishUserSubtitles(globalUserSubtitles);
  } catch (error) {
    console.error('Error loading user-provided subtitles from the active project:', error);
  }
};

const persistPendingProjectSubtitles = async (cacheId, subtitlesText) => {
  try {
    await patchProjectAuxiliary(cacheId, { userSubtitles: subtitlesText });
    if (currentCacheId === cacheId) publishUserSubtitles(subtitlesText);
  } catch (error) {
    console.error('Error saving pending user-provided subtitles to the active project:', error);
  }
};

/**
 * Set the current cache ID for the video being processed
 * @param {string} cacheId - Cache ID for the current video
 */
export const setCurrentCacheId = (cacheId) => {
  const previousCacheId = currentCacheId;
  const pendingSubtitles = globalUserSubtitles;
  currentCacheId = cacheId;
  if (previousCacheId === cacheId) return;
  publishCurrentCacheId(cacheId, previousCacheId);

  if (cacheId && previousCacheId === null && pendingSubtitles !== null) {
    void persistPendingProjectSubtitles(cacheId, pendingSubtitles);
    return;
  }

  globalUserSubtitles = null;
  publishUserSubtitles('');
  if (cacheId) void hydrateProjectSubtitles(cacheId);
};

/**
 * Get the current cache ID
 * @returns {string} Current cache ID
 */
export const getCurrentCacheId = () => {
  return currentCacheId;
};

/**
 * Set global user-provided subtitles
 * @param {string} subtitlesText - User-provided subtitles text
 */
export const setUserProvidedSubtitles = async (subtitlesText) => {
  const requestedCacheId = currentCacheId;
  globalUserSubtitles = subtitlesText;

  if (requestedCacheId) {
    await patchProjectAuxiliary(requestedCacheId, {
      userSubtitles: subtitlesText || null,
    });
  }
  if (currentCacheId === requestedCacheId) publishUserSubtitles(subtitlesText);
};

/**
 * Get global user-provided subtitles
 * @returns {string} User-provided subtitles text
 */
export const getUserProvidedSubtitles = async () => {
  // If subtitles are in memory, return them
  if (globalUserSubtitles !== null) {
    return globalUserSubtitles;
  }

  const requestedCacheId = currentCacheId;
  if (!requestedCacheId) return '';
  const auxiliary = await readProjectAuxiliary(requestedCacheId);
  if (currentCacheId !== requestedCacheId) return globalUserSubtitles || '';
  globalUserSubtitles = auxiliary?.userSubtitles ?? null;
  return globalUserSubtitles || '';
};

/**
 * Get user-provided subtitles synchronously (for components that can't use async/await)
 * @returns {string} Hydrated user-provided subtitles text from memory
 */
export const getUserProvidedSubtitlesSync = () => {
  // Project persistence is asynchronous. setCurrentCacheId hydrates this memory cache and emits an
  // update event; a synchronous read must never fall through to stale WebView storage.
  return globalUserSubtitles ?? '';
};

/**
 * Clear user-provided subtitles from memory and the active native project
 */
export const clearUserProvidedSubtitles = async () => {
  const requestedCacheId = currentCacheId;
  globalUserSubtitles = null;

  if (requestedCacheId) {
    await patchProjectAuxiliary(requestedCacheId, { userSubtitles: null });
  }
  if (currentCacheId === requestedCacheId) publishUserSubtitles('');
};
