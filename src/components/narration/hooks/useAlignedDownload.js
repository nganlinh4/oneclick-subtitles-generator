import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { downloadNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import { isNativeNarrationResult } from '../../../platform/nativeNarrationCapabilities';
import {
  generateAlignedNarration,
  getAlignedNarrationArtifactId,
} from '../../../services/alignedNarrationService';
import { createSimpleLoadingOverlay } from '../utils/loadingOverlayFactory';

const useAlignedDownload = ({ generationResults, t }) => {
  const downloadAlignedAudio = async () => {
    if (!generationResults?.length) {
      alert(t('narration.noResults', 'No narration results to download'));
      return;
    }
    const loadingOverlay = createSimpleLoadingOverlay(t(
      'narration.alignedDownloadPreparing',
      'Preparing aligned narration download...',
    ));
    try {
      const successful = generationResults.filter((result) => result.success);
      if (!isDesktopRuntime()
          || successful.length === 0
          || !successful.every(isNativeNarrationResult)) {
        throw new Error('Native narration audio is unavailable');
      }
      const generated = await generateAlignedNarration(successful, (progress) => {
        loadingOverlay.updateProgress({
          message: progress?.message || t(
            'narration.alignedDownloadPreparing',
            'Preparing aligned narration download...',
          ),
        });
      });
      const artifactId = generated && getAlignedNarrationArtifactId();
      if (!artifactId) throw new Error('Native aligned narration is unavailable');
      await downloadNativeNarration({
        success: true,
        nativeArtifactId: artifactId,
        nativeFormat: 'm4a',
        subtitle_id: 'aligned',
      }, 'aligned_narration.m4a');
    } catch (error) {
      alert(t(
        'narration.alignedDownloadFailed',
        'Error downloading aligned audio: {{error}}',
        { error: error.message },
      ));
    } finally {
      loadingOverlay.destroy();
    }
  };

  return { downloadAlignedAudio };
};

export default useAlignedDownload;
