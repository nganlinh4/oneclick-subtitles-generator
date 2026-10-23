/**
 * View records for the background image grid, and release of the native playback capabilities
 * those records hold. Browser builds carry inline data URLs and own no native capability.
 */
import { releaseNativeGeneratedImagePlayback } from '../../platform/nativeGeminiImage';

export const nativeViewImage = (image, prompt = '') => ({
  url: image.playback.playbackUrl,
  timestamp: image.artifact.createdAtMs,
  prompt,
  isLoading: false,
  nativeImage: image,
});

export const browserViewImage = (image, prompt = '') => ({
  url: `data:${image.mime_type};base64,${image.data}`,
  timestamp: Date.now(),
  prompt,
  isLoading: false,
});

export const releaseNativeImages = async (images) => {
  const playables = images
    .map((image) => image?.nativeImage)
    .filter(Boolean);
  await Promise.allSettled(
    playables.map((playable) => releaseNativeGeneratedImagePlayback(playable))
  );
};
