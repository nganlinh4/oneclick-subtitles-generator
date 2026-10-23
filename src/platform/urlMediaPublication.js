// Publication of URL-downloaded native media as its project's active media: the durable ownership
// check and active-workspace pointer, then the in-memory active media source.
import { ensureProjectOwnsNativeMedia } from './nativeMediaOwnership';
import { updateActiveMedia } from './activeMediaSource';

/**
 * Bind `media` to the exact project behind `cacheId`, record the active-workspace pointer, and only
 * then publish it as the active media. Ownership is re-validated around the durable step so a
 * superseded download never publishes, and a project mismatch raises `ownershipError()`.
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

  updateActiveMedia({ sourceUrl: url, playbackUrl: media.playbackUrl });
  return ownership;
};
