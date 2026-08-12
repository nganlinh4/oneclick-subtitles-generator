import { useEffect } from 'react';

import { isDesktopRuntime } from '../platform/desktopRuntime';
import { getSelectedMedia, isNativeMediaDescriptor } from '../platform/mediaService';
import { setCurrentCacheId as setRulesCacheId } from '../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../utils/userSubtitlesStore';

export const createNativeMediaSessionHydrator = ({
  read = getSelectedMedia,
  readStoredAssetId = () => localStorage.getItem('current_file_cache_id'),
  apply,
  validate = isNativeMediaDescriptor,
}) => {
  if (typeof read !== 'function' || typeof readStoredAssetId !== 'function'
      || typeof apply !== 'function' || typeof validate !== 'function') {
    throw new TypeError('Native media session hydration requires reviewed dependencies');
  }

  let generation = 0;
  let disposed = false;
  const hydrate = async () => {
    generation += 1;
    const requestedGeneration = generation;
    const startingAssetId = readStoredAssetId();
    let media;
    try {
      media = await read();
    } catch {
      return false;
    }
    let isValid = false;
    try {
      isValid = validate(media) === true;
    } catch {
      // The native DTO boundary is fail-closed even if a custom validator misbehaves.
    }
    if (disposed || requestedGeneration !== generation
        || readStoredAssetId() !== startingAssetId || !isValid) {
      return false;
    }
    apply(media);
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

export const useNativeMediaSessionHydration = ({ setUploadedFile }) => {
  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    const hydrator = createNativeMediaSessionHydrator({
      apply: (media) => {
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
        setRulesCacheId(media.assetId);
        setSubtitlesCacheId(media.assetId);
        setUploadedFile(media);
      },
    });
    void hydrator.hydrate();
    return () => hydrator.dispose();
  }, [setUploadedFile]);
};
