/**
 * View records for the background image grid, and release of the native playback capabilities
 * those records hold.
 */
import { releaseNativeGeneratedImagePlayback } from '../../platform/nativeGeminiImage';

export const nativeViewImage = (image, prompt = '') => ({
  url: image.playback.playbackUrl,
  timestamp: image.artifact.createdAtMs,
  prompt,
  isLoading: false,
  nativeImage: image,
});

export const releaseNativeImages = async (images) => {
  const playables = images
    .map((image) => image?.nativeImage)
    .filter(Boolean);
  await Promise.allSettled(
    playables.map((playable) => releaseNativeGeneratedImagePlayback(playable))
  );
};
