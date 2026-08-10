import { downloadNativeNarration } from '../../platform/nativeNarrationArtifacts';
import { getNativeNarrationArtifactId } from '../../platform/nativeNarrationCapabilities';
import { isNativeMediaPlaybackUrl } from '../../platform/mediaService';
import { fetchBrowserResource } from '../../platform/browserFetch';

export const downloadAudioSource = async (audioSrc, referenceAudio, {
  exportNative = downloadNativeNarration,
  fetchAudio = globalThis.fetch,
  createObjectUrl = (blob) => URL.createObjectURL(blob),
  revokeObjectUrl = (url) => URL.revokeObjectURL(url),
  createAnchor = () => document.createElement('a'),
} = {}) => {
  if (getNativeNarrationArtifactId(referenceAudio)) {
    return exportNative(referenceAudio);
  }
  if (isNativeMediaPlaybackUrl(audioSrc)) {
    throw new Error('Native audio export requires an artifact capability');
  }
  const response = await fetchBrowserResource(audioSrc, undefined, { fetchImpl: fetchAudio });
  const blob = await response.blob();
  const url = createObjectUrl(blob);
  const anchor = createAnchor();
  anchor.href = url;
  anchor.download = referenceAudio?.filename || 'audio.wav';
  anchor.click();
  revokeObjectUrl(url);
  return true;
};
