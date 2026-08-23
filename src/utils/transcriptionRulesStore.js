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
let bindingEpoch = 0;
const bindingReceipts = new WeakMap();
const BINDING_RECEIPT_KIND = 'transcription-rules-project-binding';

const projectMismatch = () => {
  const error = new Error('The active transcription-rules project changed.');
  error.name = 'ProjectScopeMismatchError';
  error.code = 'projectScopeMismatch';
  return error;
};

const explicitBindingRequired = () => {
  const error = new Error('Pending transcription rules require an awaited project binding.');
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

const publishRules = (rules, {
  cacheId = currentCacheId,
  projectId = null,
} = {}) => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('transcriptionRulesUpdated', {
      detail: { rules, cacheId, projectId }
    }));
  }
};

const hydrateProjectRules = async (cacheId, epoch = bindingEpoch) => {
  try {
    const auxiliary = await readProjectAuxiliary(cacheId);
    if (currentCacheId !== cacheId || bindingEpoch !== epoch) return;
    globalTranscriptionRules = auxiliary?.transcriptionRules ?? null;
    publishRules(globalTranscriptionRules, { cacheId });
  } catch (error) {
    console.error('Error loading transcription rules from the active project:', error);
  }
};

/**
 * Set the current cache ID for the video being processed
 * @param {string} cacheId - Cache ID for the current video
 */
export const setCurrentCacheId = (cacheId) => {
  const previousCacheId = currentCacheId;
  const pendingRules = globalTranscriptionRules;
  if (cacheId && previousCacheId === null && pendingRules !== null) {
    // A rules-first workflow used to launch an unscoped write here and immediately report the
    // project as active. If that write failed or the alias changed, the UI kept using rules which
    // never belonged to the project. Only the awaited binder below may transfer staged rules.
    throw explicitBindingRequired();
  }
  bindingEpoch += 1;
  const epoch = bindingEpoch;
  currentCacheId = cacheId;
  if (previousCacheId === cacheId) return;

  globalTranscriptionRules = null;
  publishRules(null);
  if (cacheId) void hydrateProjectRules(cacheId, epoch);
};

/**
 * Bind the rules cache to one already-resolved durable project.
 *
 * The identity changes synchronously, before the first await, but no success event is published
 * until the alias has been checked, any rules-first value has been durably written with the exact
 * project ID, and the alias has been checked again. The opaque receipt can be rolled back by the
 * two-store activation coordinator if the sibling subtitle binding fails.
 */
export const bindTranscriptionRulesProject = async (
  cacheId,
  { expectedProjectId = null } = {}
) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0
      || typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
    throw projectMismatch();
  }
  const previous = Object.freeze({
    cacheId: currentCacheId,
    rules: globalTranscriptionRules,
  });
  const pendingRules = previous.cacheId === null ? previous.rules : null;
  bindingEpoch += 1;
  const epoch = bindingEpoch;
  currentCacheId = cacheId;
  if (previous.cacheId !== cacheId && pendingRules === null) {
    globalTranscriptionRules = null;
    publishRules(null, { cacheId });
  }

  const assertOwned = () => {
    if (bindingEpoch !== epoch || currentCacheId !== cacheId) throw projectMismatch();
  };
  const restore = () => {
    if (bindingEpoch !== epoch || currentCacheId !== cacheId) return false;
    bindingEpoch += 1;
    currentCacheId = previous.cacheId;
    globalTranscriptionRules = previous.rules;
    publishRules(globalTranscriptionRules, { cacheId: previous.cacheId });
    return true;
  };

  try {
    await assertProjectId(cacheId, expectedProjectId, false);
    assertOwned();
    let rules;
    let mode;
    if (pendingRules !== null) {
      await patchProjectAuxiliary(
        cacheId,
        { transcriptionRules: pendingRules },
        { expectedProjectId }
      );
      rules = pendingRules;
      mode = 'persisted-staged';
    } else {
      const auxiliary = await readProjectAuxiliary(cacheId, { expectedProjectId });
      rules = auxiliary?.transcriptionRules ?? null;
      mode = 'hydrated';
    }
    assertOwned();
    await assertProjectId(cacheId, expectedProjectId, false);
    assertOwned();
    globalTranscriptionRules = rules;
    publishRules(rules, { cacheId, projectId: expectedProjectId });
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

export const isTranscriptionRulesProjectBindingReceipt = (receipt, {
  cacheId,
  projectId,
} = {}) => (
  receipt?.kind === BINDING_RECEIPT_KIND
  && bindingReceipts.has(receipt)
  && receipt.cacheId === cacheId
  && receipt.projectId === projectId
);

export const rollbackTranscriptionRulesProjectBinding = (receipt) => {
  const owned = receipt && typeof receipt === 'object' ? bindingReceipts.get(receipt) : null;
  if (!owned) return false;
  bindingReceipts.delete(receipt);
  if (bindingEpoch !== owned.epoch || currentCacheId !== receipt.cacheId) return false;
  bindingEpoch += 1;
  currentCacheId = owned.previous.cacheId;
  globalTranscriptionRules = owned.previous.rules;
  publishRules(globalTranscriptionRules, { cacheId: owned.previous.cacheId });
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
  if (currentCacheId === requestedCacheId) publishRules(rules, { cacheId: requestedCacheId });
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
  publishRules(globalTranscriptionRules, {
    cacheId,
    projectId: expectedProjectId,
  });
  return { previousRules, rules: globalTranscriptionRules };
};

/**
 * Atomically persist the exact accepted provider analysis and the rules derived from it.
 * A caller may acknowledge the provider delivery only after this function resolves.
 */
export const commitVideoAnalysisForCache = async (
  cacheId,
  { rules, analysis },
  { expectedProjectId = null } = {}
) => {
  if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
    throw projectMismatch();
  }
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, true);
  assertProjectScope(cacheId);
  const previousRules = globalTranscriptionRules;
  const persisted = await patchProjectAuxiliary(
    cacheId,
    {
      transcriptionRules: rules ?? null,
      analysis,
    },
    { expectedProjectId }
  );
  assertProjectScope(cacheId);
  await assertProjectId(cacheId, expectedProjectId, false);
  assertProjectScope(cacheId);
  if (persisted?.analysis?.providerJobId !== analysis?.providerJobId
      || persisted?.analysis?.deliveryId !== analysis?.deliveryId
      || persisted?.analysis?.sourceIdentity !== analysis?.sourceIdentity) {
    throw projectMismatch();
  }
  globalTranscriptionRules = rules ?? null;
  publishRules(globalTranscriptionRules, {
    cacheId,
    projectId: expectedProjectId,
  });
  return Object.freeze({
    cacheId,
    projectId: expectedProjectId,
    providerJobId: analysis.providerJobId,
    deliveryId: analysis.deliveryId,
    previousRules,
    rules: globalTranscriptionRules,
  });
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
  if (currentCacheId === requestedCacheId) {
    publishRules(null, { cacheId: requestedCacheId });
  }
};
