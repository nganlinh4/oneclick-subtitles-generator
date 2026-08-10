import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { isDesktopRuntime } from './desktopRuntime';
import { isNativeMediaDescriptor, isNativeMediaPlaybackUrl } from './mediaService';

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const readActiveIdentity = () => {
  try {
    return {
      assetId: localStorage.getItem('current_file_cache_id'),
      playbackUrl: localStorage.getItem('current_file_url'),
    };
  } catch {
    return { assetId: null, playbackUrl: null };
  }
};

export const resolveActiveNativeMediaAssetId = (value) => {
  if (!isDesktopRuntime()) return null;
  if (isNativeMediaDescriptor(value)) return value.assetId;
  if (typeof value !== 'string' || !isNativeMediaPlaybackUrl(value)) return null;

  const active = readActiveIdentity();
  if (active.playbackUrl !== value || !isUuidV7(active.assetId)) return null;
  return active.assetId;
};
