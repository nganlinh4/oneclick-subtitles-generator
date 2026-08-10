import {
  createNativeNarrationToken,
  getNativeNarrationArtifactId,
} from '../../../platform/nativeNarrationCapabilities';

/**
 * Shared reference-audio localStorage caching helpers.
 *
 * Centralizes the previously-duplicated media-id resolution and cache-write logic used after
 * upload / record / extract / example-select so there is one clear way to persist the reference
 * voice (auto-restored on reload).
 */

/**
 * Resolve the current media id from localStorage (YouTube video id or cached file id).
 * @returns {string|null}
 */
export const getCurrentMediaId = () => {
  const currentVideoUrl = localStorage.getItem('current_video_url');
  const currentFileUrl = localStorage.getItem('current_file_url');

  if (currentVideoUrl) {
    const match = currentVideoUrl.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  } else if (currentFileUrl) {
    return localStorage.getItem('current_file_cache_id');
  }
  return null;
};

/**
 * Persist the reference audio to localStorage keyed by current media id (best-effort).
 * @param {{filename: string, text: string, url: string, filepath: string}} referenceAudio
 * @param {string} [logLabel] - Optional label for the success log line.
 */
export const cacheReferenceAudio = (referenceAudio, logLabel) => {
  try {
    const mediaId = getCurrentMediaId();
    const artifactId = getNativeNarrationArtifactId(referenceAudio);
    if (mediaId && artifactId) {
      const persistedReference = {
        nativeArtifactId: artifactId,
        filename: createNativeNarrationToken(artifactId),
        format: referenceAudio.format,
        durationMicros: referenceAudio.durationMicros,
        text: referenceAudio.text || '',
        language: referenceAudio.language,
      };
      localStorage.setItem('reference_audio_cache', JSON.stringify({
        mediaId,
        timestamp: Date.now(),
        referenceAudio: persistedReference
      }));
      void logLabel;
    }
  } catch {
    // Reference caching is best-effort; the native artifact remains authoritative.
  }
};
