import { useTranslation } from 'react-i18next';
import StandardSlider from '../common/StandardSlider';
import { formatTime } from '../../utils/timeFormatter';

const timeLabelStyle = {
  minWidth: 70,
  maxWidth: 70,
  display: 'inline-block',
  textAlign: 'center',
  fontSize: '1.15em',
  fontFamily: 'monospace',
  fontWeight: 500,
};

const finiteNonNegative = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
);

/** Project a durable trim window onto the current source's authoritative browser duration. */
export const boundedTrimRange = (renderSettings, videoDuration) => {
  const sourceEnd = finiteNonNegative(videoDuration);
  if (!(sourceEnd > 0)) return Object.freeze([0, 0]);
  const requestedStart = finiteNonNegative(renderSettings?.trimStart);
  const requestedEnd = renderSettings?.trimEnd === 0
    ? sourceEnd
    : finiteNonNegative(renderSettings?.trimEnd);
  const end = Math.min(requestedEnd, sourceEnd);
  return Object.freeze([Math.min(requestedStart, end), end]);
};

/** Keep the durable zero spelling for "through source end"; never persist rounded metadata back. */
export const durableTrimRange = (range, videoDuration) => {
  const sourceEnd = finiteNonNegative(videoDuration);
  const [start, end] = boundedTrimRange({ trimStart: range?.[0], trimEnd: range?.[1] }, sourceEnd);
  return Object.freeze({
    trimStart: start,
    trimEnd: sourceEnd > 0 && sourceEnd - end <= 0.005 ? 0 : end,
  });
};

/**
 * Trim timeline row: a range slider over the video duration that also seeks the
 * preview player. Pure component — state and the player ref come from props.
 */
const TrimTimelineRow = ({ renderSettings, setRenderSettings, videoDuration, videoPlayerRef }) => {
  const { t } = useTranslation();
  const [boundedStart, boundedEnd] = boundedTrimRange(renderSettings, videoDuration);

  return (
    <div className="trimming-timeline-row" style={{ margin: '0 0 16px 0', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px' }}>
        <span className="material-symbols-rounded" style={{ flexShrink: 0}}>content_cut</span>
        <span style={timeLabelStyle}>
          {formatTime(boundedStart, 'hms_ms')}
        </span>
        <StandardSlider
          range
          value={[
            boundedStart,
            boundedEnd,
          ]}
          min={0}
          // *** FIX ***
          // Use the independent videoDuration state for the slider's max value.
          // Default to 1 to prevent errors before duration is known.
          max={videoDuration || 1}
          step={0.01}
          onChange={([start, end]) => {
            const [nextStart, nextEnd] = boundedTrimRange(
              { trimStart: start, trimEnd: end },
              videoDuration,
            );
            const durable = durableTrimRange([start, end], videoDuration);
            setRenderSettings(prev => ({ ...prev, ...durable }));

            const oldStart = boundedStart;
            const oldEnd = boundedEnd;

            // Seek the preview player to the new position
            if (videoPlayerRef.current) {
              const frameRate = renderSettings.frameRate || 30;
              if (nextStart !== oldStart) {
                // Seek to start position
                const frameToSeek = Math.floor(nextStart * frameRate);
                videoPlayerRef.current.seekTo(frameToSeek);
              } else if (nextEnd !== oldEnd) {
                // Seek to end position
                const frameToSeek = Math.floor(nextEnd * frameRate);
                videoPlayerRef.current.seekTo(frameToSeek);
              }
            }
          }}
          orientation="Horizontal"
          size="Large"
          width="full"
          showValueIndicator={false}
          showStops={false}
          className="trimming-slider trim-slider"
          id="trimming-slider"
          ariaLabel={t('videoRendering.trimmingTimeline', 'Trim Video')}
          style={{
            width: '-webkit-fill-available',
            maxWidth: 'none'
          }}
        />
        <span style={timeLabelStyle}>
          {formatTime(boundedEnd, 'hms_ms')}
        </span>
      </div>
    </div>
  );
};

export default TrimTimelineRow;
