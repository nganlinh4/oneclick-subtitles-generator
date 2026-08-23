import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../../platform/activeNativeMedia';
import { inspectMediaPipelineAsset } from '../../platform/mediaPipelineService';

export const fetchPreviewInfo = async (url, explicitAssetId = null) => {
  let capability = null;
  try {
    if (explicitAssetId === null) {
      capability = await resolveActiveNativeMedia({ candidate: url });
    }
    const assetId = explicitAssetId ?? capability.assetId;
    const inspection = await inspectMediaPipelineAsset(assetId);
    if (capability !== null) await revalidateActiveNativeMedia(capability);
    return {
      success: true,
      width: inspection.width,
      height: inspection.height,
      fps: inspection.frameRate,
      quality: inspection.height === null ? null : `${inspection.height}p`,
      codec: inspection.videoCodec,
      audio_codec: inspection.audioCodec,
    };
  } catch {
    return null;
  }
};

export const fetchPreviewExtra = async (url, {
  assetId = null,
  sizeBytes = null,
} = {}) => {
  if (Number.isSafeInteger(sizeBytes) && sizeBytes > 0 && assetId) {
    return { size: sizeBytes, createdAt: null };
  }
  try {
    const capability = await resolveActiveNativeMedia({ candidate: url });
    return { size: capability.media.size, createdAt: null };
  } catch {
    return null;
  }
};

export const fetchHeadInfo = fetchPreviewExtra;
