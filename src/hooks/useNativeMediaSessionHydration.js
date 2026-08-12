import { useEffect } from 'react';

import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
  getSelectedMedia,
  isNativeMediaDescriptor,
  restoreMediaAsset,
} from '../platform/mediaService';
import { setCurrentCacheId as setRulesCacheId } from '../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../utils/userSubtitlesStore';

export const createNativeMediaSessionHydrator = ({
  read = getSelectedMedia,
  restore = restoreMediaAsset,
  readStoredAssetId = () => localStorage.getItem('current_file_cache_id'),
  apply,
  validate = isNativeMediaDescriptor,
}) => {
  if (typeof read !== 'function' || typeof restore !== 'function'
      || typeof readStoredAssetId !== 'function'
      || typeof apply !== 'function' || typeof validate !== 'function') {
    throw new TypeError('Native media session hydration requires reviewed dependencies');
  }

  let generation = 0;
  let disposed = false;
  const hydrate = async () => {
    generation += 1;
    const requestedGeneration = generation;
    let startingAssetId;
    try {
      startingAssetId = readStoredAssetId();
    } catch {
      return false;
    }
    const identityIsCurrent = () => {
      try {
        return readStoredAssetId() === startingAssetId;
      } catch {
        return false;
      }
    };
    let media;
    try {
      media = await read();
    } catch {
      return false;
    }
    if (disposed || requestedGeneration !== generation || !identityIsCurrent()) {
      return false;
    }

    let restoredRequestedAsset = false;
    if (media === null) {
      if (startingAssetId === null) return false;
      try {
        media = await restore(startingAssetId);
        restoredRequestedAsset = media !== null;
      } catch {
        return false;
      }
      if (media === null) {
        if (disposed || requestedGeneration !== generation || !identityIsCurrent()) {
          return false;
        }
        try {
          media = await read();
        } catch {
          return false;
        }
      }
    }
    let isValid = false;
    try {
      isValid = validate(media) === true;
    } catch {
      // The native DTO boundary is fail-closed even if a custom validator misbehaves.
    }
    if (disposed || requestedGeneration !== generation || !identityIsCurrent() || !isValid
        || (restoredRequestedAsset && media.assetId !== startingAssetId)) {
      return false;
    }
    try {
      apply(media);
    } catch {
      return false;
    }
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
  setUploadedFile,
  setRulesCacheIdImpl = setRulesCacheId,
  setSubtitlesCacheIdImpl = setSubtitlesCacheId,
}) => {
  if (!isNativeMediaDescriptor(media) || typeof setUploadedFile !== 'function'
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
  setRulesCacheIdImpl(media.assetId);
  setSubtitlesCacheIdImpl(media.assetId);
  setUploadedFile(media);
};

export const useNativeMediaSessionHydration = ({ setUploadedFile }) => {
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    const hydrator = createNativeMediaSessionHydrator({
      apply: (media) => applyNativeMediaSession({ media, setUploadedFile }),
    });
    void hydrator.hydrate();
    return () => hydrator.dispose();
  }, [setUploadedFile]);
};
