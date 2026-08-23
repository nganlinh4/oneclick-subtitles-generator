import { isDesktopRuntime } from '../platform/desktopRuntime';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';
import {
  requireSuccessfulSubtitleCacheSave,
  saveSubtitlesToCache,
} from '../services/subtitleCache';
import { getCurrentCacheId } from './userSubtitlesStore';

const scopeFailure = () => {
  const error = new Error('The active subtitle project changed during import.');
  error.name = 'ProjectScopeMismatchError';
  error.code = 'projectScopeMismatch';
  return error;
};

export const createImportedSubtitlePersistence = ({
  desktop = isDesktopRuntime,
  readCacheId = getCurrentCacheId,
  resolveProject = resolveProjectForCache,
  save = saveSubtitlesToCache,
} = {}) => async (subtitles) => {
  if (!desktop()) return Object.freeze({ status: 'deferred' });
  if (!Array.isArray(subtitles) || subtitles.length === 0) throw scopeFailure();

  const cacheId = readCacheId();
  // A URL may accept subtitles before its media has been downloaded and activated. There is no
  // project to own them yet; the download path calls the same import handler again after activation.
  if (typeof cacheId !== 'string' || cacheId.length === 0) {
    return Object.freeze({ status: 'deferred' });
  }

  const resolved = await resolveProject(cacheId, { create: false });
  if (readCacheId() !== cacheId || typeof resolved?.projectId !== 'string') throw scopeFailure();
  const result = await save(cacheId, subtitles, { expectedProjectId: resolved.projectId });
  requireSuccessfulSubtitleCacheSave(result);
  if (readCacheId() !== cacheId
      || result.cacheId !== cacheId || result.projectId !== resolved.projectId
      || result.subtitleCount !== subtitles.length) {
    throw scopeFailure();
  }
  return result;
};

export const persistImportedSubtitlesForActiveProject = createImportedSubtitlePersistence();

export const createImportedSubtitleClear = ({
  desktop = isDesktopRuntime,
  readCacheId = getCurrentCacheId,
  resolveProject = resolveProjectForCache,
  save = saveSubtitlesToCache,
} = {}) => async () => {
  if (!desktop()) return Object.freeze({ status: 'deferred' });

  const cacheId = readCacheId();
  if (typeof cacheId !== 'string' || cacheId.length === 0) {
    return Object.freeze({ status: 'deferred' });
  }

  const resolved = await resolveProject(cacheId, { create: false });
  if (readCacheId() !== cacheId || typeof resolved?.projectId !== 'string') throw scopeFailure();
  const result = await save(cacheId, [], { expectedProjectId: resolved.projectId });
  requireSuccessfulSubtitleCacheSave(result);
  if (readCacheId() !== cacheId
      || result.cacheId !== cacheId
      || result.projectId !== resolved.projectId
      || result.subtitleCount !== 0) {
    throw scopeFailure();
  }
  return result;
};

export const clearImportedSubtitlesForActiveProject = createImportedSubtitleClear();
