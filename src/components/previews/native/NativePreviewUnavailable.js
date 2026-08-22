import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FONT_READINESS_STATE } from '../../../services/fontCapability';
import { retryManagedFont } from '../../../services/fontRepair';
import { useFontReadiness } from '../../../services/useFontReadiness';

/**
 * What a preview surface says when the compositor is not drawing the subtitle.
 *
 * Nothing in the WebView composes subtitle appearance any more, so "no native frame" has exactly one
 * honest presentation: say so. Leaving a bare `<video>` on screen reads as "my subtitles
 * disappeared", and drawing an approximation of them is the silent substitution the migration exists
 * to remove — so the surface reports the state instead of illustrating it.
 *
 * IT MUST NOT LOOK LIKE A SUBTITLE. It reads no field of `subtitleSettings`, it sits in the flow
 * above the video rather than over the frame where a cue sits, and it wears the same plain `.error`
 * treatment every other refusal on this surface wears. A user must never be able to mistake it for
 * the rendered result.
 *
 * THE STATES IT DISTINGUISHES:
 *
 *   - PREPARING — native has SAID the managed subtitle font is being resolved or repaired. This is
 *     waiting, not failure, and must not be presented as an error; it used to be indistinguishable
 *     from dormancy, which is how a font that finished installing moments later went unnoticed. It
 *     requires an actual published record: with nothing published — a browser, or a test that staged
 *     none — there is no reason to believe anything is in progress, and saying otherwise would be a
 *     wait that can never end.
 *   - FONT REFUSED — the font could not be installed. Shows the typed cause and, when native says
 *     retrying could help, a button that asks native to install it again.
 *   - DORMANT (`code === null`) — a frame was needed and never asked for: no desktop runtime, no
 *     resolved project/media, no decoded source size. Nothing was refused, so nothing is retried.
 *   - REFUSED — work was attempted and declined. `code` is a stable identifier carrying no path, no
 *     native message and none of the user's text. `onRetry` releases the preview surface, which is
 *     the ONLY recovery from a lost graphics device: that refusal is terminal for the
 *     (project, media) pair until the surface is released.
 */
const NativePreviewUnavailable = ({ code = null, onRetry = null }) => {
  const { t } = useTranslation();
  const font = useFontReadiness();
  const [repairing, setRepairing] = useState(false);

  const repairFont = useCallback(async () => {
    setRepairing(true);
    try {
      await retryManagedFont();
    } finally {
      // Native publishes the outcome through the readiness record; this flag only stops the button
      // being pressed twice while the request is in flight.
      setRepairing(false);
    }
  }, []);

  // The font is the reason nothing can be drawn, and it is a reason with an owner and an action.
  // Reported ahead of the generic dormancy below, which by construction cannot say why.
  if (code === null && font.published && !font.managedPackInstalled) {
    if (font.readiness === FONT_READINESS_STATE.resolving
      || font.readiness === FONT_READINESS_STATE.repairing) {
      return (
        <div className="error native-preview-unavailable" role="status">
          <span>
            {t(
              'videoPreview.subtitleFontPreparing',
              'Preparing the subtitle font. The preview will appear when it is ready.',
            )}
          </span>
        </div>
      );
    }

    return (
      <div className="error native-preview-unavailable" role="status">
        <span>
          {t(
            'videoPreview.subtitleFontUnavailable',
            'The subtitle font could not be installed ({{reason}}), so subtitles cannot be drawn.',
            { reason: font.reason ?? 'unknown' },
          )}
        </span>
        {font.retryable && (
          <button
            type="button"
            className="native-preview-retry"
            onClick={repairFont}
            disabled={repairing}
          >
            {t('videoPreview.retrySubtitleFont', 'Install again')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="error native-preview-unavailable" role="status">
      <span>
        {code === null
          ? t(
            'videoPreview.subtitlePreviewUnavailable',
            'Subtitle preview unavailable. The video below is the source, without subtitles.',
          )
          : t('videoPreview.renderError', 'Error rendering subtitles: {{error}}', { error: code })}
      </span>
      {onRetry !== null && (
        <button type="button" className="native-preview-retry" onClick={onRetry}>
          {t('videoPreview.retrySubtitlePreview', 'Retry')}
        </button>
      )}
    </div>
  );
};

export default NativePreviewUnavailable;
