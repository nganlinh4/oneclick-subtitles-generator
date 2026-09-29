import { getCurrentCacheId } from '../utils/userSubtitlesStore';
import { resolveProjectForCache, restoreActiveSubtitleProject } from './subtitleProjectStore';
import { activateSubtitleProjectBinding } from './subtitleProjectBinding';

export const isSubtitleDocumentCacheId = (value) => (
  typeof value === 'string' && value.startsWith('subtitle-document:')
);

/** Attaching the first media must not throw away a document's track, edits or translations. */
export const resolveProjectForMedia = async (cacheId, options) => {
  const current = getCurrentCacheId();
  if (options?.create && isSubtitleDocumentCacheId(current)) {
    const document = await resolveProjectForCache(current, { create: false });
    if (getCurrentCacheId() !== current) {
      throw new Error('The subtitle document changed while selecting media.');
    }
    if (document?.snapshot?.media?.length === 0) return document;
  }
  return resolveProjectForCache(cacheId, options);
};

/** Restore documents before attempting media restoration; a document has no playback capability. */
export const restoreSubtitleDocument = async ({ isCurrent = () => true } = {}) => {
  const resolved = await restoreActiveSubtitleProject();
  if (!isCurrent() || getCurrentCacheId() !== null) return false;
  if (!isSubtitleDocumentCacheId(resolved?.cacheId) || resolved.snapshot.media.length !== 0) return false;
  await activateSubtitleProjectBinding(resolved.cacheId, {
    create: false, expectedProjectId: resolved.projectId,
  });
  return isCurrent() && getCurrentCacheId() === resolved.cacheId;
};
