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
import { setCurrentCacheId as setRulesCacheId } from '../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../utils/userSubtitlesStore';

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
  readStoredAssetId = () => localStorage.getItem('current_file_cache_id'),
  readSession = readNativeMediaSession,
  resolveOwner = resolveOwnedNativeMediaProject,
  activate = activateResolvedMediaProject,
  apply,
  validate = isNativeMediaDescriptor,
}) => {
  if (typeof read !== 'function' || typeof restore !== 'function'
      || typeof readStoredAssetId !== 'function' || typeof readSession !== 'function'
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
      // The identity key is cleared whenever the app drops its media, which disables restoration
      // without any teardown site needing to know this hook exists.
      if (session === null || readStoredAssetId() !== session.assetId) return false;
    } catch {
      return false;
    }

    const owns = () => {
      try {
        const current = readSession();
        return current !== null
          && current.assetId === session.assetId
          && current.cacheId === session.cacheId
          && current.projectId === session.projectId
          && readStoredAssetId() === session.assetId;
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

    // The native session already holds media in this process, so no project has to be published.
    if (media !== null) {
      if (!isNativeMediaDescriptor(media) || media.assetId !== session.assetId) return false;
      try {
        apply({ media, cacheId: session.cacheId });
      } catch {
        return false;
      }
      return true;
    }

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

    let restored = null;
    let restoreFailed = false;
    try {
      restored = await restore(session.assetId);
    } catch {
      restoreFailed = true;
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
      apply({ media: restored, cacheId: session.cacheId });
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
  setUploadedFile,
  setRulesCacheIdImpl = setRulesCacheId,
  setSubtitlesCacheIdImpl = setSubtitlesCacheId,
}) => {
  if (!isNativeMediaDescriptor(media)
      || typeof cacheId !== 'string' || cacheId.length === 0
      || typeof setUploadedFile !== 'function'
      || typeof setRulesCacheIdImpl !== 'function'
      || typeof setSubtitlesCacheIdImpl !== 'function') {
    throw new TypeError('Native media session application requires reviewed dependencies');
  }

  const previousUrl = localStorage.getItem('current_file_url');
  if (previousUrl?.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(previousUrl);
    } catch {
      // An old browser-only object URL is already inert.
    }
  }
  localStorage.setItem('current_file_url', media.playbackUrl);
  localStorage.setItem('current_file_cache_id', media.assetId);
  // The alias, not the asset, owns the subtitles and rules: a URL download keeps them across
  // re-downloads that mint a new asset.
  setRulesCacheIdImpl(cacheId);
  setSubtitlesCacheIdImpl(cacheId);
  setUploadedFile(media);
};

export const useNativeMediaSessionHydration = ({ setUploadedFile }) => {
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    const hydrator = createNativeMediaSessionHydrator({
      apply: ({ media, cacheId }) => applyNativeMediaSession({ media, cacheId, setUploadedFile }),
    });
    void hydrator.hydrate();
    return () => hydrator.dispose();
  }, [setUploadedFile]);
};
