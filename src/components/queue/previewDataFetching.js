import { resolveActiveNativeMediaAssetId } from '../../platform/activeNativeMedia';
import { inspectMediaPipelineAsset } from '../../platform/mediaPipelineService';
import { getSelectedMedia } from '../../platform/mediaService';

export const fetchPreviewInfo = async (url, explicitAssetId = null) => {
  const assetId = explicitAssetId || resolveActiveNativeMediaAssetId(url);
  if (assetId === null) return null;
  try {
    const inspection = await inspectMediaPipelineAsset(assetId);
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
    const selected = await getSelectedMedia();
    return selected?.playbackUrl === url
      ? { size: selected.size, createdAt: null }
      : null;
  } catch {
    return null;
  }
};

export const fetchHeadInfo = fetchPreviewExtra;
