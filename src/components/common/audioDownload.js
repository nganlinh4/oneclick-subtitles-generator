import { downloadNativeNarration } from '../../platform/nativeNarrationArtifacts';
import { getNativeNarrationArtifactId } from '../../platform/nativeNarrationCapabilities';
import { isNativeMediaPlaybackUrl } from '../../platform/mediaService';
import { fetchBrowserResource } from '../../platform/browserFetch';
import { exportGeneratedBlob } from '../../platform/generatedFileExportService';

export const downloadAudioSource = async (audioSrc, referenceAudio, {
  exportNative = downloadNativeNarration,
  fetchAudio = globalThis.fetch,
  exportGenerated = exportGeneratedBlob,
} = {}) => {
  if (getNativeNarrationArtifactId(referenceAudio)) {
    return exportNative(referenceAudio);
  }
  if (isNativeMediaPlaybackUrl(audioSrc)) {
    throw new Error('Native audio export requires an artifact capability');
  }
  const blob = referenceAudio?.blob instanceof Blob
    ? referenceAudio.blob
    : await (await fetchBrowserResource(audioSrc, undefined, { fetchImpl: fetchAudio })).blob();
  return exportGenerated(blob, referenceAudio?.filename || 'recording');
};
