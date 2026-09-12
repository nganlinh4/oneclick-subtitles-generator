import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { downloadNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import { isNativeNarrationResult } from '../../../platform/nativeNarrationCapabilities';
import { showErrorToast } from '../../../utils/toastUtils';

/**
 * Export one native narration artifact through the host-owned save dialog.
 */
export const downloadAudio = async (result, t) => {
  try {
    if (!isDesktopRuntime() || !isNativeNarrationResult(result)) {
      throw new Error('Native narration audio is unavailable');
    }
    await downloadNativeNarration(result);
  } catch (error) {
    showErrorToast(t(
      'narration.downloadError',
      `Error downloading audio file: ${error.message}`,
    ));
  }
};
