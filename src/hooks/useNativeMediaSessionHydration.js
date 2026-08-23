import { useEffect } from 'react';

import { isDesktopRuntime } from '../platform/desktopRuntime';
import { activateResolvedMediaProject } from '../platform/mediaProjectActivation';
import {
  getSelectedMedia,
  isNativeMediaDescriptor,
  restoreMediaAsset,
} from '../platform/mediaService';
import {
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../platform/nativeMediaOwnership';
import {
  activateSubtitleProjectBinding,
  isSubtitleProjectBindingReceipt,
} from '../platform/subtitleProjectBinding';

/**
 * Restore the media a previous run left active.
 *
 * A fresh process has no native session and no active project, and the durable playback URL from
 * the last run is dead, so the asset has to be reopened. That reopen is only permitted for media
 * its project still owns, so the remembered session pointer is resolved to a project, that exact
 * project is published, and only then is the asset reopened. Every step re-checks that the pointer
 * still describes this run; anything else fails closed without touching storage.
 */
export const createNativeMediaSessionHydrator = ({
  read = getSelectedMedia,
  restore = restoreMediaAsset,
  readSession = readNativeMediaSession,
  resolveOwner = resolveOwnedNativeMediaProject,
  activate = activateResolvedMediaProject,
  apply,
  validate = isNativeMediaDescriptor,
}) => {
  if (typeof read !== 'function' || typeof restore !== 'function'
      || typeof readSession !== 'function'
      || typeof resolveOwner !== 'function' || typeof activate !== 'function'
      || typeof apply !== 'function' || typeof validate !== 'function') {
    throw new TypeError('Native media session hydration requires reviewed dependencies');
  }

  let generation = 0;
  let disposed = false;

  const hydrate = async () => {
    generation += 1;
    const requestedGeneration = generation;

    let session;
    try {
      session = readSession();
      if (session === null) return false;
    } catch {
      return false;
    }

    const owns = () => {
      try {
        const current = readSession();
        return current !== null
          && current.assetId === session.assetId
          && current.cacheId === session.cacheId
          && current.projectId === session.projectId;
      } catch {
        return false;
      }
    };
    const guard = () => !disposed && requestedGeneration === generation && owns();

    let media;
    try {
      media = await read();
    } catch {
      return false;
    }
    if (!guard()) return false;

    const resolved = await resolveOwner(session);
    if (!guard() || resolved === null) return false;

    let activation;
    try {
      activation = await activate(resolved, {
        validateOwnership: () => {
          if (!guard()) throw new Error('The media session was superseded');
        },
      });
    } catch {
      return false;
    }

    let restored = media;
    let restoreFailed = false;
    if (restored === null) {
      try {
        restored = await restore(session.assetId);
      } catch {
        restoreFailed = true;
      }
    }
    // A lost only-if-empty race means another activation already published its own alias; adopting
    // its winner here would rebind the subtitle stores to the wrong project.
    if (restoreFailed || restored === null || !guard()) {
      activation.release();
      return false;
    }

    let isValid = false;
    try {
      isValid = validate(restored) === true;
    } catch {
      // The native DTO boundary is fail-closed even if a custom validator misbehaves.
    }
    if (!isValid || restored.assetId !== session.assetId || !guard()) {
      activation.release();
      return false;
    }

    try {
      await apply({
        media: restored,
        cacheId: session.cacheId,
        projectId: session.projectId,
        validateOwnership: guard,
      });
    } catch {
      activation.release();
      return false;
    }
    // The published project is the app's active project from here on, exactly as it is after a
    // download claim, so the activation is deliberately kept.
    return true;
  };

  return Object.freeze({
    dispose: () => {
      disposed = true;
      generation += 1;
    },
    hydrate,
  });
};

export const applyNativeMediaSession = ({
  media,
  cacheId,
  projectId,
  setUploadedFile,
  activateBindingImpl = activateSubtitleProjectBinding,
  validateBindingImpl = isSubtitleProjectBindingReceipt,
  validateOwnership = () => true,
}) => {
  if (!isNativeMediaDescriptor(media)
      || typeof cacheId !== 'string' || cacheId.length === 0
      || typeof projectId !== 'string' || projectId.length === 0
      || typeof setUploadedFile !== 'function'
      || typeof activateBindingImpl !== 'function'
      || typeof validateBindingImpl !== 'function'
      || typeof validateOwnership !== 'function') {
    throw new TypeError('Native media session application requires reviewed dependencies');
  }
  return activateBindingImpl(cacheId, { expectedProjectId: projectId, create: false })
    .then((receipt) => {
      if (!validateBindingImpl(receipt, { cacheId, projectId })) {
        throw new Error('The restored media subtitle project could not be verified.');
      }
      if (validateOwnership() !== true) {
        throw new Error('The restored media session was superseded.');
      }
      // These are write-only compatibility mirrors for old UI teardown. Restoration and every
      // product operation derive identity from the native project/session capability above.
      const previousUrl = localStorage.getItem('current_file_url');
      if (previousUrl?.startsWith('blob:') && previousUrl !== media.playbackUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      localStorage.setItem('current_file_url', media.playbackUrl);
      localStorage.setItem('current_file_cache_id', media.assetId);
      setUploadedFile(media);
      return receipt;
    });
};

export const useNativeMediaSessionHydration = ({ setUploadedFile }) => {
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    const hydrator = createNativeMediaSessionHydrator({
      apply: ({ media, cacheId, projectId, validateOwnership }) => applyNativeMediaSession({
        media,
        cacheId,
        projectId,
        setUploadedFile,
        validateOwnership,
      }),
    });
    void hydrator.hydrate();
    return () => hydrator.dispose();
  }, [setUploadedFile]);
};
