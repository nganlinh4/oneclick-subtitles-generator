import { isDesktopRuntime } from '../../../platform/desktopRuntime';
import { downloadNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import {
  getNativeNarrationArtifactId,
  isNativeNarrationResult,
} from '../../../platform/nativeNarrationCapabilities';

/**
 * Export one native narration artifact through the host-owned save dialog.
 * The retained parameters keep the render-facing call contract stable.
 */
export const downloadAudio = async (result, _getAudioUrl, t) => {
  try {
    if (!isDesktopRuntime() || !isNativeNarrationResult(result)) {
      throw new Error('Native narration audio is unavailable');
    }
    await downloadNativeNarration(result);
  } catch (error) {
    alert(t(
      'narration.downloadError',
      `Error downloading audio file: ${error.message}`,
    ));
  }
};

/**
 * Native generation publishes immutable artifacts before returning to React, so there is no
 * browser-owned PCM/base64 payload to persist. This compatibility helper only confirms that a
 * result already owns a durable artifact.
 */
export const saveAudioToServer = async (result) => (
  isDesktopRuntime() && getNativeNarrationArtifactId(result)
    ? result.filename
    : null
);
