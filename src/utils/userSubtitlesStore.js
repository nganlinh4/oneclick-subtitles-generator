/**
 * Store for user-provided subtitles
 * This file is used to manage user-provided subtitles and persist them for the current video
 */

import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';

// Store user-provided subtitles globally
let globalUserSubtitles = null;

// Current cache ID for the video being processed
let currentCacheId = null;
let bindingEpoch = 0;
const bindingReceipts = new WeakMap();
const BINDING_RECEIPT_KIND = 'user-subtitles-project-binding';
const currentCacheIdListeners = new Set();
const currentProjectRefreshListeners = new Set();

const projectMismatch = () => {
  const error = new Error('The active user-subtitle project changed.');
  error.name = 'ProjectScopeMismatchError';
  error.code = 'projectScopeMismatch';
  return error;
};

const explicitBindingRequired = () => {
  const error = new Error('Pending user subtitles require an awaited project binding.');
  error.name = 'ProjectBindingRequiredError';
  error.code = 'projectBindingRequired';
  return error;
};

const assertProjectScope = (cacheId) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0 || currentCacheId !== cacheId) {
    throw projectMismatch();
  }
};

const assertProjectId = async (cacheId, expectedProjectId, create = false) => {
  const resolved = await resolveProjectForCache(cacheId, { create });
  if (!resolved?.projectId || (expectedProjectId && resolved.projectId !== expectedProjectId)) {
    throw projectMismatch();
  }
  return resolved;
};

export const subscribeCurrentCacheId = (listener) => {
  if (typeof listener !== 'function') {
    throw new TypeError('A current subtitle cache listener is required');
  }
  currentCacheIdListeners.add(listener);
  return () => currentCacheIdListeners.delete(listener);
};

/**
 * Subscribe to an authoritative revision of the currently bound subtitle project whose cache
 * alias did not change (for example, replacing a re-downloaded media asset for the same URL).
 * This is deliberately separate from identity changes: translation/generation ownership must not
 * be cancelled merely because the same project published a newer snapshot.
 */
export const subscribeCurrentSubtitleProjectRefresh = (listener) => {
  if (typeof listener !== 'function') {
    throw new TypeError('A current subtitle project refresh listener is required');
  }
  currentProjectRefreshListeners.add(listener);
  return () => currentProjectRefreshListeners.delete(listener);
};

export const refreshCurrentSubtitleProject = (cacheId) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0 || cacheId !== currentCacheId) {
    throw projectMismatch();
  }
  currentProjectRefreshListeners.forEach((listener) => {
    try {
      listener(cacheId);
    } catch (error) {
      console.error('Current subtitle project refresh listener failed:', error);
    }
  });
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

const publishUserSubtitles = (subtitlesText, {
  cacheId = currentCacheId,
  projectId = null,
} = {}) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('userProvidedSubtitlesUpdated', {
      detail: { subtitlesText: subtitlesText || '', cacheId, projectId }
    }));
  }
};

const hydrateProjectSubtitles = async (cacheId, epoch = bindingEpoch) => {
  try {
    const auxiliary = await readProjectAuxiliary(cacheId);
    if (currentCacheId !== cacheId || bindingEpoch !== epoch) return;
    globalUserSubtitles = auxiliary?.userSubtitles ?? null;
    publishUserSubtitles(globalUserSubtitles, { cacheId });
  } catch (error) {
    console.error('Error loading user-provided subtitles from the active project:', error);
  }
};

/**
 * Set the current cache ID for the video being processed
 * @param {string} cacheId - Cache ID for the current video
 */
export const setCurrentCacheId = (cacheId) => {
  const previousCacheId = currentCacheId;
  const pendingSubtitles = globalUserSubtitles;
  if (cacheId && previousCacheId === null && pendingSubtitles !== null) {
    throw explicitBindingRequired();
  }
  bindingEpoch += 1;
  const epoch = bindingEpoch;
  currentCacheId = cacheId;
  if (previousCacheId === cacheId) return;
  publishCurrentCacheId(cacheId, previousCacheId);

  globalUserSubtitles = null;
  publishUserSubtitles('');
  if (cacheId) void hydrateProjectSubtitles(cacheId, epoch);
};

/** Awaited, exact-project binding used by media activation and SRT-first workflows. */
export const bindUserSubtitlesProject = async (
  cacheId,
  { expectedProjectId = null } = {}
) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0
      || typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
    throw projectMismatch();
  }
  const previous = Object.freeze({
    cacheId: currentCacheId,
    subtitles: globalUserSubtitles,
  });
  const pendingSubtitles = previous.cacheId === null ? previous.subtitles : null;
  bindingEpoch += 1;
  const epoch = bindingEpoch;
  currentCacheId = cacheId;
  if (previous.cacheId !== cacheId) publishCurrentCacheId(cacheId, previous.cacheId);
  if (previous.cacheId !== cacheId && pendingSubtitles === null) {
    globalUserSubtitles = null;
    publishUserSubtitles('');
  }

  const assertOwned = () => {
    if (bindingEpoch !== epoch || currentCacheId !== cacheId) throw projectMismatch();
  };
  const restore = () => {
    if (bindingEpoch !== epoch || currentCacheId !== cacheId) return false;
    bindingEpoch += 1;
    const failedCacheId = currentCacheId;
    currentCacheId = previous.cacheId;
    globalUserSubtitles = previous.subtitles;
    if (failedCacheId !== previous.cacheId) {
      publishCurrentCacheId(previous.cacheId, failedCacheId);
    }
    publishUserSubtitles(globalUserSubtitles);
    return true;
  };

  try {
    await assertProjectId(cacheId, expectedProjectId, false);
    assertOwned();
    let subtitles;
    let mode;
    if (pendingSubtitles !== null) {
      await patchProjectAuxiliary(
        cacheId,
        { userSubtitles: pendingSubtitles },
        { expectedProjectId }
      );
      subtitles = pendingSubtitles;
      mode = 'persisted-staged';
    } else {
      const auxiliary = await readProjectAuxiliary(cacheId, { expectedProjectId });
      subtitles = auxiliary?.userSubtitles ?? null;
      mode = 'hydrated';
    }
    assertOwned();
    await assertProjectId(cacheId, expectedProjectId, false);
    assertOwned();
    globalUserSubtitles = subtitles;
    publishUserSubtitles(subtitles, { cacheId, projectId: expectedProjectId });
    const receipt = Object.freeze({
      kind: BINDING_RECEIPT_KIND,
      cacheId,
      projectId: expectedProjectId,
      mode,
    });
    bindingReceipts.set(receipt, Object.freeze({ epoch, previous }));
    return receipt;
  } catch (error) {
    restore();
    throw error;
  }
};

export const isUserSubtitlesProjectBindingReceipt = (receipt, {
  cacheId,
  projectId,
} = {}) => (
  receipt?.kind === BINDING_RECEIPT_KIND
  && bindingReceipts.has(receipt)
  && receipt.cacheId === cacheId
  && receipt.projectId === projectId
);

export const rollbackUserSubtitlesProjectBinding = (receipt) => {
  const owned = receipt && typeof receipt === 'object' ? bindingReceipts.get(receipt) : null;
  if (!owned) return false;
  bindingReceipts.delete(receipt);
  if (bindingEpoch !== owned.epoch || currentCacheId !== receipt.cacheId) return false;
  bindingEpoch += 1;
  const failedCacheId = currentCacheId;
  currentCacheId = owned.previous.cacheId;
  globalUserSubtitles = owned.previous.subtitles;
  if (failedCacheId !== owned.previous.cacheId) {
    publishCurrentCacheId(owned.previous.cacheId, failedCacheId);
  }
  publishUserSubtitles(globalUserSubtitles);
  return true;
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
  const previousSubtitles = globalUserSubtitles;
  globalUserSubtitles = subtitlesText;

  try {
    if (requestedCacheId) {
      await patchProjectAuxiliary(requestedCacheId, {
        userSubtitles: subtitlesText || null,
      });
    }
  } catch (error) {
    if (currentCacheId === requestedCacheId) {
      globalUserSubtitles = previousSubtitles;
      publishUserSubtitles(previousSubtitles);
    }
    throw error;
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

export const getUserProvidedSubtitlesForCache = async (
  cacheId,
  { expectedProjectId = null } = {}
) => {
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, false);
  const auxiliary = await readProjectAuxiliary(cacheId, { expectedProjectId });
  assertProjectScope(cacheId);
  return auxiliary?.userSubtitles ?? '';
};

export const setUserProvidedSubtitlesForCache = async (
  cacheId,
  subtitlesText,
  { expectedProjectId = null } = {}
) => {
  if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
    throw projectMismatch();
  }
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, true);
  assertProjectScope(cacheId);
  await patchProjectAuxiliary(
    cacheId,
    { userSubtitles: subtitlesText || null },
    { expectedProjectId }
  );
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, false);
  assertProjectScope(cacheId);
  globalUserSubtitles = subtitlesText || null;
  publishUserSubtitles(globalUserSubtitles);
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
