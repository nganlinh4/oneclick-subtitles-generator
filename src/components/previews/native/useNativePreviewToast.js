import { useEffect } from 'react';

import { FONT_READINESS_STATE } from '../../../services/fontCapability';
import { retryManagedFont } from '../../../services/fontRepair';
import { useFontReadiness } from '../../../services/useFontReadiness';

const TOAST_KEY = 'native-subtitle-preview';

/** Keep diagnostics out of the picture while making a real refusal visible and recoverable. */
const useNativePreviewToast = ({ error, dormant = false, onRetry = null, t }) => {
  const font = useFontReadiness();

  useEffect(() => {
    if (error === null && !dormant) {
      window.removeToastByKey?.(TOAST_KEY);
      return undefined;
    }

    const timer = setTimeout(() => {
      const code = error?.nativeCode ?? error?.code ?? null;
      const fontBlocked = code === null && font.published && !font.managedPackInstalled;
      const fontPreparing = fontBlocked && (
        font.readiness === FONT_READINESS_STATE.resolving
        || font.readiness === FONT_READINESS_STATE.repairing
      );
      const message = code !== null
        ? t('videoPreview.renderError', 'Error rendering subtitles: {{error}}', { error: code })
        : fontPreparing
          ? t('videoPreview.subtitleFontPreparing', 'Preparing the subtitle font. The preview will appear when it is ready.')
          : fontBlocked
            ? t(
              'videoPreview.subtitleFontUnavailable',
              'The subtitle font could not be installed ({{reason}}), so subtitles cannot be drawn.',
              { reason: font.reason ?? 'unknown' },
            )
            : t('videoPreview.subtitlePreviewUnavailable', 'Subtitle preview is not ready. Try reopening this video.');
      const button = code !== null && onRetry !== null
        ? { text: t('videoPreview.retrySubtitlePreview', 'Retry'), onClick: onRetry }
        : fontBlocked && font.retryable
          ? { text: t('videoPreview.retrySubtitleFont', 'Install again'), onClick: retryManagedFont }
          : undefined;
      window.addToast?.(
        message,
        fontPreparing ? 'info' : code === null ? 'warning' : 'error',
        8000,
        TOAST_KEY,
        button,
      );
    }, error === null ? 1200 : 0);

    return () => clearTimeout(timer);
  }, [dormant, error, font, onRetry, t]);
};

export default useNativePreviewToast;
