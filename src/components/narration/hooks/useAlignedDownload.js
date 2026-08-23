import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { downloadNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import {
  generateAlignedNarration,
  getAlignedNarrationArtifactIdForPlan,
} from '../../../services/alignedNarrationService';
import { buildStrictNativeNarrationPlan } from '../../../utils/narrationAlignmentUtils';
import { createSimpleLoadingOverlay } from '../utils/loadingOverlayFactory';
import { showErrorToast, showSuccessToast, showWarningToast } from '../../../utils/toastUtils';

const useAlignedDownload = ({ generationResults, getCurrentCues, t }) => {
  const downloadAlignedAudio = async () => {
    if (!generationResults?.length) {
      showWarningToast(t('narration.noResults', 'No narration results to download'));
      return;
    }
    const loadingOverlay = createSimpleLoadingOverlay(t(
      'narration.alignedDownloadPreparing',
      'Preparing aligned narration download...',
    ));
    try {
      if (!isDesktopRuntime()) {
        throw new Error('Native narration audio is unavailable');
      }
      const currentCues = getCurrentCues?.();
      const plan = buildStrictNativeNarrationPlan(generationResults, currentCues);
      await generateAlignedNarration(generationResults, currentCues, (progress) => {
        loadingOverlay.updateProgress({
          message: progress?.message || t(
            'narration.alignedDownloadPreparing',
            'Preparing aligned narration download...',
          ),
        });
      });
      const artifactId = getAlignedNarrationArtifactIdForPlan(plan);
      if (!artifactId) throw new Error('Native aligned narration is unavailable');
      await downloadNativeNarration({
        success: true,
        nativeArtifactId: artifactId,
        nativeFormat: 'm4a',
        subtitle_id: 'aligned',
      }, 'aligned_narration.m4a');
      showSuccessToast(t(
        'narration.alignedDownloadComplete',
        'Aligned narration was saved successfully.',
      ));
    } catch (error) {
      showErrorToast(t(
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
