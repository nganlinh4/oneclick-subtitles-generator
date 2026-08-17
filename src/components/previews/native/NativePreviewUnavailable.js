import { useTranslation } from 'react-i18next';

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
 * TWO STATES, ONE NOTICE:
 *
 *   - DORMANT (`code === null`) means no frame was ever asked for — no desktop runtime, no resolved
 *     project/media, no decoded source size, no resolvable font face. Nothing was refused, so there
 *     is nothing to retry and no retry is offered.
 *   - REFUSED means work was attempted and declined. `code` is a stable identifier and carries no
 *     path, no native message and none of the user's text. `onRetry` releases the preview surface,
 *     which is the ONLY recovery from a lost graphics device: that refusal is terminal for the
 *     (project, media) pair until the surface is released, so without this the rest of the session
 *     would show no composited frame at all.
 */
const NativePreviewUnavailable = ({ code = null, onRetry = null }) => {
  const { t } = useTranslation();

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
