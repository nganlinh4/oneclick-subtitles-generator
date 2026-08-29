// Centralized subtitle cache + cache ID utilities

import {
  extractDouyinVideoId,
  extractYoutubeVideoId,
} from '../utils/mediaUrl';
import {
  captureProjectSubtitleSegmentRevision,
  clearProjectSubtitles,
  commitProjectSubtitleSegmentRevision,
  loadExactProjectSubtitles,
  loadProjectSubtitles,
  resolveProjectForCache,
  saveProjectSubtitles,
} from '../platform/subtitleProjectStore';

const durableCheckpointReceipts = new WeakSet();
const successfulSaveReceipts = new WeakSet();

export class SubtitleCacheError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubtitleCacheError';
    this.code = code;
  }
}

const readFailure = () => new SubtitleCacheError(
  'subtitleCacheReadFailed',
  'Saved subtitles could not be loaded.'
);

const saveFailure = () => new SubtitleCacheError(
  'subtitleCacheSaveFailed',
  'Subtitles could not be saved.'
);

/**
 * Generate a consistent cache ID from any video URL
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export const generateUrlBasedCacheId = async (url) => {
  if (!url) return null;
  try {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      return extractYoutubeVideoId(url);
    }
    if (url.includes('douyin.com')) {
      return extractDouyinVideoId(url);
    }
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace('www.', '');
    const path = urlObj.pathname.replace(/\//g, '_');
    const query = urlObj.search.replace(/[^a-zA-Z0-9]/g, '_');
    const baseId = `${domain}${path}${query}`.replace(/[^a-zA-Z0-9]/g, '_');
    const cleanId = baseId.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return `site_${cleanId}`;
  } catch (error) {
    console.error('[subtitleCache] Error generating URL-based cache ID:', error);
    return null;
  }
};

/**
 * Check if cached subtitles exist for a cache ID and return them if valid.
 * Validates URL association for non-file uploads.
 * @param {string} cacheId
 * @param {string|null} currentVideoUrl
 * @param {{expectedProjectId?: string|null}} options
 * @returns {Promise<Array|null>}
 */
export const getCachedSubtitles = async (
  cacheId,
  _currentVideoUrl = null,
  { expectedProjectId = null } = {}
) => {
  try {
    return expectedProjectId === null
      ? await loadProjectSubtitles(cacheId)
      : await loadExactProjectSubtitles(cacheId, expectedProjectId);
  } catch {
    const error = readFailure();
    console.error('[subtitleCache] Native subtitle read failed:', error.code);
    throw error;
  }
};

/**
 * Save subtitles to cache with metadata
 * @param {string} cacheId
 * @param {Array} subtitles
 */
export const saveSubtitlesToCache = async (
  cacheId,
  subtitles,
  { expectedProjectId = null } = {}
) => {
  try {
    const resolved = await resolveProjectForCache(cacheId, { create: true });
    if (!resolved?.projectId
        || (expectedProjectId !== null && resolved.projectId !== expectedProjectId)) {
      throw saveFailure();
    }
    let projectId = resolved.projectId;
    if (Array.isArray(subtitles) && subtitles.length === 0) {
      await clearProjectSubtitles(cacheId, { expectedProjectId: projectId });
    } else {
      const snapshot = await saveProjectSubtitles(cacheId, subtitles, {
        expectedProjectId: projectId,
      });
      projectId = snapshot?.metadata?.id ?? projectId;
    }
    if (expectedProjectId !== null && projectId !== expectedProjectId) throw saveFailure();
    const receipt = Object.freeze({
      success: true,
      cacheId,
      projectId,
      subtitleCount: Array.isArray(subtitles) ? subtitles.length : 0,
    });
    successfulSaveReceipts.add(receipt);
    return receipt;
  } catch {
    const error = saveFailure();
    console.error('[subtitleCache] Native subtitle save failed:', error.code);
    return { success: false, error };
  }
};

export const isSuccessfulSubtitleCacheSaveReceipt = (value) => (
  value !== null
  && typeof value === 'object'
  && successfulSaveReceipts.has(value)
  && value.success === true
  && typeof value.cacheId === 'string'
  && typeof value.projectId === 'string'
  && Number.isSafeInteger(value.subtitleCount)
  && value.subtitleCount >= 0
);

export const requireSuccessfulSubtitleCacheSave = (result) => {
  if (!result || result.success !== true) {
    throw result?.error instanceof SubtitleCacheError ? result.error : saveFailure();
  }
};

/**
 * Await one exact-project subtitle checkpoint owned by a captured run.
 *
 * Callers provide the ownership validator because auto-generation, ASR, and
 * retry flows capture media identity differently. The validator is executed
 * directly before and after the project-scoped native write, and success is a
 * frozen receipt rather than an optimistic boolean.
 */
export const commitDurableSubtitleCheckpoint = async ({
  context,
  subtitles,
  validateOwnership,
}) => {
  if (!context
      || typeof context.runId !== 'string' || context.runId.length === 0
      || typeof context.cacheId !== 'string' || context.cacheId.length === 0
      || typeof context.projectId !== 'string' || context.projectId.length === 0
      || (context.signal && context.signal.aborted)
      || !Array.isArray(subtitles)
      || typeof validateOwnership !== 'function') {
    throw saveFailure();
  }
  await validateOwnership(context);
  const result = await saveSubtitlesToCache(context.cacheId, subtitles, {
    expectedProjectId: context.projectId,
  });
  requireSuccessfulSubtitleCacheSave(result);
  await validateOwnership(context);
  if (result.cacheId !== context.cacheId
      || result.projectId !== context.projectId
      || result.subtitleCount !== subtitles.length) {
    throw saveFailure();
  }
  const receipt = Object.freeze({
    kind: 'durable-subtitle-checkpoint',
    runId: context.runId,
    cacheId: result.cacheId,
    projectId: result.projectId,
    subtitleCount: result.subtitleCount,
  });
  durableCheckpointReceipts.add(receipt);
  return receipt;
};

export const captureDurableSubtitleSegmentRevision = async ({
  context,
  validateOwnership,
}) => {
  if (!context || typeof validateOwnership !== 'function') throw saveFailure();
  await validateOwnership(context);
  const revision = await captureProjectSubtitleSegmentRevision(
    context.cacheId,
    context.segment,
    { expectedProjectId: context.projectId }
  );
  await validateOwnership(context);
  if (revision.cacheId !== context.cacheId || revision.projectId !== context.projectId) {
    throw saveFailure();
  }
  return revision;
};

/**
 * Commit one regenerated range without replacing the rest of the track. The
 * returned receipt is privately branded only after the native project commit
 * has completed and contains the authoritative post-commit rows.
 */
export const commitDurableSubtitleSegmentCheckpoint = async ({
  context,
  revision,
  replacement,
  validateOwnership,
}) => {
  if (!context
      || typeof context.runId !== 'string' || context.runId.length === 0
      || typeof context.cacheId !== 'string' || context.cacheId.length === 0
      || typeof context.projectId !== 'string' || context.projectId.length === 0
      || context.signal?.aborted
      || !Array.isArray(replacement)
      || typeof validateOwnership !== 'function') {
    throw saveFailure();
  }
  await validateOwnership(context);
  const committed = await commitProjectSubtitleSegmentRevision(revision, replacement, {
    expectedProjectId: context.projectId,
  });
  await validateOwnership(context);
  if (committed.cacheId !== context.cacheId
      || committed.projectId !== context.projectId
      || !Array.isArray(committed.rows)) {
    throw saveFailure();
  }
  const receipt = Object.freeze({
    kind: 'durable-subtitle-segment-checkpoint',
    runId: context.runId,
    cacheId: committed.cacheId,
    projectId: committed.projectId,
    subtitleCount: committed.rows.length,
    subtitles: committed.rows,
    stateVersion: committed.stateVersion,
  });
  durableCheckpointReceipts.add(receipt);
  return receipt;
};

/**
 * Verify provenance from this module's exact durable write. Matching fields alone are insufficient:
 * object literals, clones, and serialized receipts were never observed completing the native save.
 */
export const isDurableSubtitleCheckpointReceipt = (value, context = null) => (
  value !== null
  && typeof value === 'object'
  && durableCheckpointReceipts.has(value)
  && (context === null || (
    value.runId === context.runId
    && value.cacheId === context.cacheId
    && value.projectId === context.projectId
  ))
);
