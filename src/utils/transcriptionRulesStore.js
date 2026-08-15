/**
 * Store for transcription rules
 * This file is used to avoid circular dependencies between videoProcessor.js and geminiService.js
 * and to persist transcription rules for the current video
 */

import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';

// Store transcription rules globally
let globalTranscriptionRules = null;

// Current cache ID for the video being processed
let currentCacheId = null;

const projectMismatch = () => {
  const error = new Error('The active transcription-rules project changed.');
  error.name = 'ProjectScopeMismatchError';
  error.code = 'projectScopeMismatch';
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

const publishRules = (rules) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('transcriptionRulesUpdated', {
      detail: { rules }
    }));
  }
};

const hydrateProjectRules = async (cacheId) => {
  try {
    const auxiliary = await readProjectAuxiliary(cacheId);
    if (currentCacheId !== cacheId) return;
    globalTranscriptionRules = auxiliary?.transcriptionRules ?? null;
    publishRules(globalTranscriptionRules);
  } catch (error) {
    console.error('Error loading transcription rules from the active project:', error);
  }
};

const persistPendingProjectRules = async (cacheId, rules) => {
  try {
    await patchProjectAuxiliary(cacheId, { transcriptionRules: rules });
    if (currentCacheId === cacheId) publishRules(rules);
  } catch (error) {
    console.error('Error saving pending transcription rules to the active project:', error);
  }
};

/**
 * Set the current cache ID for the video being processed
 * @param {string} cacheId - Cache ID for the current video
 */
export const setCurrentCacheId = (cacheId) => {
  const previousCacheId = currentCacheId;
  const pendingRules = globalTranscriptionRules;
  currentCacheId = cacheId;
  if (previousCacheId === cacheId) return;

  if (cacheId && previousCacheId === null && pendingRules !== null) {
    void persistPendingProjectRules(cacheId, pendingRules);
    return;
  }

  globalTranscriptionRules = null;
  publishRules(null);
  if (cacheId) void hydrateProjectRules(cacheId);
};

/**
 * Get the current cache ID
 * @returns {string} Current cache ID
 */
export const getCurrentCacheId = () => {
  return currentCacheId;
};

/**
 * Set global transcription rules
 * @param {Object} rules - Transcription rules
 */
export const setTranscriptionRules = async (rules) => {
  const requestedCacheId = currentCacheId;
  const previousRules = globalTranscriptionRules;
  globalTranscriptionRules = rules;

  try {
    if (requestedCacheId) {
      await patchProjectAuxiliary(requestedCacheId, {
        transcriptionRules: rules ?? null,
      });
    }
  } catch (error) {
    if (currentCacheId === requestedCacheId) {
      globalTranscriptionRules = previousRules;
      publishRules(previousRules);
    }
    throw error;
  }
  if (currentCacheId === requestedCacheId) publishRules(rules);
};

/**
 * Get global transcription rules
 * @returns {Object} Transcription rules
 */
export const getTranscriptionRules = async () => {
  // If rules are in memory, return them
  if (globalTranscriptionRules !== null) {
    return globalTranscriptionRules;
  }

  const requestedCacheId = currentCacheId;
  if (!requestedCacheId) return null;
  const auxiliary = await readProjectAuxiliary(requestedCacheId);
  if (currentCacheId !== requestedCacheId) return globalTranscriptionRules;
  globalTranscriptionRules = auxiliary?.transcriptionRules ?? null;
  return globalTranscriptionRules;
};

/**
 * Get transcription rules synchronously (for components that can't use async/await)
 * @returns {Object} Hydrated transcription rules from memory
 */
export const getTranscriptionRulesSync = () => {
  // Project persistence is asynchronous and is hydrated when the cache/project alias changes.
  return globalTranscriptionRules;
};

/** Read rules for one captured project without switching the global active project. */
export const getTranscriptionRulesForCache = async (
  cacheId,
  { expectedProjectId = null } = {}
) => {
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, false);
  const auxiliary = await readProjectAuxiliary(cacheId, { expectedProjectId });
  assertProjectScope(cacheId);
  return auxiliary?.transcriptionRules ?? null;
};

/** Persist rules only for the still-active captured project. */
export const setTranscriptionRulesForCache = async (
  cacheId,
  rules,
  { expectedProjectId = null } = {}
) => {
  if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
    throw projectMismatch();
  }
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, true);
  assertProjectScope(cacheId);
  const previousRules = globalTranscriptionRules;
  await patchProjectAuxiliary(
    cacheId,
    { transcriptionRules: rules ?? null },
    { expectedProjectId }
  );
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, false);
  assertProjectScope(cacheId);
  globalTranscriptionRules = rules ?? null;
  publishRules(globalTranscriptionRules);
  return { previousRules, rules: globalTranscriptionRules };
};

/**
 * Clear transcription rules from memory and the active native project
 */
export const clearTranscriptionRules = async () => {
  const requestedCacheId = currentCacheId;
  globalTranscriptionRules = null;

  if (requestedCacheId) {
    await patchProjectAuxiliary(requestedCacheId, { transcriptionRules: null });
  }

  // Clear ephemeral analysis state tied to the rules.
  sessionStorage.removeItem('current_session_preset_id');
  sessionStorage.removeItem('last_applied_recommendation');
  sessionStorage.removeItem('current_session_video_fingerprint');
  sessionStorage.removeItem('current_session_prompt');
  localStorage.removeItem('video_analysis_result');
  if (currentCacheId === requestedCacheId) publishRules(null);
};
