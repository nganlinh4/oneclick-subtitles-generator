import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import {
  downloadNativeNarrations,
  resolveNativeNarrationPlayback,
} from '../../../platform/nativeNarrationArtifacts';
import { isNativeNarrationResult } from '../../../platform/nativeNarrationCapabilities';
import { createLoadingOverlay } from '../utils/loadingOverlayFactory';

const useNarrationDownloads = ({
  generationResults,
  currentAudio,
  setCurrentAudio,
  isPlaying,
  setIsPlaying,
  t,
}) => {
  const playAudio = async (result) => {
    try {
      if (!isDesktopRuntime() || !isNativeNarrationResult(result)) {
        throw new Error('Native narration audio is unavailable');
      }
      if (isPlaying && currentAudio?.id === result.subtitle_id) {
        setIsPlaying(false);
        setCurrentAudio(null);
        return;
      }
      setIsPlaying(false);
      setCurrentAudio(null);
      const playable = await resolveNativeNarrationPlayback(result);
      setCurrentAudio({
        id: result.subtitle_id,
        url: playable.audioUrl,
        nativePlaybackId: playable.nativePlaybackId,
        ts: Date.now(),
      });
      setIsPlaying(true);
    } catch {
      setCurrentAudio(null);
      setIsPlaying(false);
    }
  };

  const downloadAllAudio = async () => {
    if (!generationResults?.length) {
      alert(t('narration.noResults', 'No narration results to download'));
      return;
    }
    const loadingOverlay = createLoadingOverlay(
      t('narration.downloading', 'Downloading audio files...'),
    );
    try {
      const successful = generationResults.filter((result) => result.success);
      if (!isDesktopRuntime()
          || successful.length === 0
          || !successful.every(isNativeNarrationResult)) {
        throw new Error('Native narration audio is unavailable');
      }
      await downloadNativeNarrations(successful);
    } catch (error) {
      alert(t(
        'narration.downloadError',
        `Error downloading audio files: ${error.message}`,
      ));
    } finally {
      loadingOverlay.destroy();
    }
  };

  return { playAudio, downloadAllAudio };
};

export default useNarrationDownloads;
