// Publication of URL-downloaded native media as its project's active media: the durable ownership
// check and active-workspace pointer, then the browser compatibility keys old UI code still reads.
import { ensureProjectOwnsNativeMedia } from './nativeMediaOwnership';

const COMPATIBILITY_KEYS = Object.freeze({
  fileName: 'current_file_name',
  fileUrl: 'current_file_url',
  splitResult: 'split_result',
  videoUrl: 'current_video_url',
});

/** Snapshot the compatibility keys a media publication overwrites, for an exact rollback. */
export const captureMediaCompatibility = () => Object.freeze(Object.fromEntries(
  Object.entries(COMPATIBILITY_KEYS).map(([field, key]) => [field, localStorage.getItem(key)])
));

export const restoreMediaCompatibility = (snapshot) => {
  for (const [field, key] of Object.entries(COMPATIBILITY_KEYS)) {
    const value = snapshot[field];
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
};

/**
 * Bind `media` to the exact project behind `cacheId`, record the active-workspace pointer, and only
 * then mirror it into the compatibility keys. Ownership is re-validated around the durable step so
 * a superseded download never publishes, and a project mismatch raises `ownershipError()`.
 */
export const publishOwnedUrlMedia = async ({
  media,
  cacheId,
  projectId,
  url,
  validateOwnership,
  ownershipError,
}) => {
  await validateOwnership();
  const ownership = await ensureProjectOwnsNativeMedia({
    media,
    cacheId,
    expectedProjectId: projectId,
  });
  await validateOwnership();
  if (ownership.projectId !== projectId) throw ownershipError();

  localStorage.removeItem(COMPATIBILITY_KEYS.splitResult);
  localStorage.setItem(COMPATIBILITY_KEYS.videoUrl, url);
  localStorage.setItem(COMPATIBILITY_KEYS.fileUrl, media.playbackUrl);
  localStorage.setItem(COMPATIBILITY_KEYS.fileName, media.name);
  return ownership;
};
