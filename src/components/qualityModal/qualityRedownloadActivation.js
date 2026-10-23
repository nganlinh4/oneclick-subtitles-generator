// The activation transaction of a quality re-download: the new asset replaces the active media of
// the SAME project and alias, exactly like a URL-download activation, or the previous media,
// pointer and preview are restored.
import {
  getSelectedMedia,
  openMediaAsset,
} from '../../platform/mediaService';
import {
  ensureProjectOwnsNativeMedia,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../../platform/nativeMediaOwnership';
import {
  activateSubtitleProjectBinding,
  rollbackSubtitleProjectBinding,
} from '../../platform/subtitleProjectBinding';
import { publishOwnedUrlMedia } from '../../platform/urlMediaPublication';
import {
  captureActiveMediaSource,
  restoreActiveMediaSource,
  updateActiveMedia,
} from '../../platform/activeMediaSource';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';

const ownershipLost = () => {
  const error = new Error('The active media changed during the quality download.');
  error.name = 'QualityRedownloadOwnershipError';
  error.code = 'qualityRedownloadOwnershipLost';
  return error;
};

const sameSession = (left, right) => (
  left !== null && right !== null
  && left?.assetId === right?.assetId
  && left.cacheId === right.cacheId
  && left.projectId === right.projectId
);

/**
 * Prove that `url` is the source of the media the active-workspace pointer names, then return the
 * admit/publish/rollback callbacks the native URL download claims its candidate through.
 *
 * The pointer's alias must be the URL's alias and must still own the pointed-to asset (resolved
 * without creating anything), so a re-download can neither land in another project nor mint one.
 * `onMediaReplaced` receives the descriptor the preview must show: the new media on success, or
 * the reopened previous media when a rollback had to re-register its playback.
 */
export const createQualityRedownloadActivation = async ({ url, onMediaReplaced }) => {
  if (typeof onMediaReplaced !== 'function') throw ownershipLost();
  const session = readNativeMediaSession();
  const cacheId = await generateUrlBasedCacheId(url);
  if (session === null || session.cacheId !== cacheId) throw ownershipLost();
  if (await resolveOwnedNativeMediaProject(session) === null) throw ownershipLost();
  if (!sameSession(readNativeMediaSession(), session)) throw ownershipLost();

  let expected = session;
  let publishing = null;
  let previousMedia = null;
  let previousSource = null;

  // Until the publication lands the pointer must still name the previous media; while it is being
  // written either pointer is this transaction's own.
  const validateOwnership = () => {
    const current = readNativeMediaSession();
    if (!sameSession(current, expected) && !sameSession(current, publishing)) {
      throw ownershipLost();
    }
  };

  const admitActivation = async ({ resolvedProject, url: completedUrl }, { validateOwnership: assertOwned }) => {
    await assertOwned();
    if (completedUrl !== url
        || resolvedProject?.cacheId !== session.cacheId
        || resolvedProject.projectId !== session.projectId) {
      throw ownershipLost();
    }
    const selected = await getSelectedMedia();
    await assertOwned();
    if (selected?.assetId !== session.assetId) throw ownershipLost();
    previousMedia = selected;
    previousSource = captureActiveMediaSource();
    let binding = null;
    try {
      binding = await activateSubtitleProjectBinding(session.cacheId, {
        expectedProjectId: session.projectId,
        create: false,
      });
      await assertOwned();
      return binding;
    } catch (error) {
      if (binding !== null) rollbackSubtitleProjectBinding(binding);
      throw error;
    }
  };

  const publishActivation = async (media, binding, { validateOwnership: assertOwned }) => {
    publishing = Object.freeze({
      assetId: media.assetId,
      cacheId: session.cacheId,
      projectId: binding.projectId,
    });
    await publishOwnedUrlMedia({
      media,
      cacheId: session.cacheId,
      projectId: binding.projectId,
      url,
      validateOwnership: assertOwned,
      ownershipError: ownershipLost,
    });
    expected = publishing;
    publishing = null;
    onMediaReplaced(media);
  };

  // The claim replaced the project's media and the host's playback. Reattach the previous asset to
  // the same project (which also restores its pointer), then re-register its playback only if the
  // host no longer serves the exact previous capability.
  const rollbackActivation = async () => {
    publishing = null;
    if (previousMedia === null) return;
    await ensureProjectOwnsNativeMedia({
      media: previousMedia,
      cacheId: session.cacheId,
      expectedProjectId: session.projectId,
    });
    expected = session;
    restoreActiveMediaSource(previousSource);
    const current = await getSelectedMedia();
    if (current?.assetId === previousMedia.assetId
        && current.playbackId === previousMedia.playbackId) {
      return;
    }
    const reopened = await openMediaAsset(previousMedia.assetId);
    if (reopened?.assetId !== previousMedia.assetId) {
      throw new Error('The previous native media selection could not be restored.');
    }
    updateActiveMedia({ playbackUrl: reopened.playbackUrl });
    onMediaReplaced(reopened);
  };

  return Object.freeze({
    validateOwnership,
    admitActivation,
    publishActivation,
    rollbackActivation,
  });
};
