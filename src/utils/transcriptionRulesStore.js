/**
 * Store for transcription rules
 * This file is used to avoid circular dependencies between videoProcessor.js and geminiService.js
 * and to persist transcription rules for the current video
 */

import { patchProjectAuxiliary, readProjectAuxiliary } from '../platform/projectAuxiliaryStore';

// Store transcription rules globally
let globalTranscriptionRules = null;

// Current cache ID for the video being processed
let currentCacheId = null;

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
  globalTranscriptionRules = rules;

  if (requestedCacheId) {
    await patchProjectAuxiliary(requestedCacheId, {
      transcriptionRules: rules ?? null,
    });
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
