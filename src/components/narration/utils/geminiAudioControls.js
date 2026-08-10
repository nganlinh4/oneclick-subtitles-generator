import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import {
  downloadNativeNarration,
  releaseNativeNarrationPlayback,
  resolveNativeNarrationPlayback,
} from '../../../platform/nativeNarrationArtifacts';
import { isNativeNarrationResult } from '../../../platform/nativeNarrationCapabilities';

const releaseCurrent = (audioRef) => {
  const audio = audioRef.current;
  if (!audio) return;
  try {
    audio.pause();
  } catch {
    // Playback teardown is best-effort.
  }
  if (audio.__nativeNarrationPlayback) {
    releaseNativeNarrationPlayback(audio.__nativeNarrationPlayback);
    audio.__nativeNarrationPlayback = null;
  }
  audioRef.current = null;
};

export const playAudio = async (result, {
  audioRef,
  currentlyPlaying,
  isPlaying,
  setCurrentlyPlaying,
  setIsPlaying,
}) => {
  if (!isDesktopRuntime() || !isNativeNarrationResult(result)) {
    releaseCurrent(audioRef);
    setIsPlaying(false);
    setCurrentlyPlaying(null);
    return;
  }
  if (currentlyPlaying === result.subtitle_id && isPlaying) {
    releaseCurrent(audioRef);
    setIsPlaying(false);
    setCurrentlyPlaying(null);
    return;
  }
  releaseCurrent(audioRef);
  try {
    const playable = await resolveNativeNarrationPlayback(result);
    const audio = new Audio(playable.audioUrl);
    audio.preload = 'none';
    audio.__nativeNarrationPlayback = playable;
    const finish = () => {
      if (audio.__nativeNarrationPlayback) {
        releaseNativeNarrationPlayback(audio.__nativeNarrationPlayback);
        audio.__nativeNarrationPlayback = null;
      }
      if (audioRef.current === audio) audioRef.current = null;
      setIsPlaying(false);
      setCurrentlyPlaying(null);
    };
    audio.onended = finish;
    audio.onerror = finish;
    audioRef.current = audio;
    setCurrentlyPlaying(result.subtitle_id);
    setIsPlaying(true);
    await audio.play();
  } catch {
    releaseCurrent(audioRef);
    setIsPlaying(false);
    setCurrentlyPlaying(null);
  }
};

export const downloadAudio = async (result, t) => {
  try {
    if (!isDesktopRuntime() || !isNativeNarrationResult(result)) {
      throw new Error('Native narration audio is unavailable');
    }
    await downloadNativeNarration(result);
  } catch (error) {
    window.addToast?.(t(
      'narration.downloadError',
      `Error downloading audio file: ${error.message}`,
    ), 'error');
  }
};
