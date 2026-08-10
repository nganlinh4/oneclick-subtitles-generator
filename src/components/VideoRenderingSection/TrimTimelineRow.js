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

/**
 * Trim timeline row: a range slider over the video duration that also seeks the
 * Remotion preview. Pure component — state and the player ref come from props.
 */
const TrimTimelineRow = ({ renderSettings, setRenderSettings, videoDuration, videoPlayerRef }) => {
  const { t } = useTranslation();

  return (
    <div className="trimming-timeline-row" style={{ margin: '0 0 16px 0', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px' }}>
        <span className="material-symbols-rounded" style={{ flexShrink: 0}}>content_cut</span>
        <span style={timeLabelStyle}>
          {formatTime(renderSettings.trimStart || 0, 'hms_ms')}
        </span>
        <StandardSlider
          range
          value={[
            renderSettings.trimStart || 0,
            renderSettings.trimEnd || 0
          ]}
          min={0}
          // *** FIX ***
          // Use the independent videoDuration state for the slider's max value.
          // Default to 1 to prevent errors before duration is known.
          max={videoDuration || 1}
          step={0.01}
          onChange={([start, end]) => {
            setRenderSettings(prev => ({ ...prev, trimStart: start, trimEnd: end }));

            const oldStart = renderSettings.trimStart || 0;
            const oldEnd = renderSettings.trimEnd || 0;

            // Seek the Remotion player to the new position
            if (videoPlayerRef.current) {
              const frameRate = renderSettings.frameRate || 30;
              if (start !== oldStart) {
                // Seek to start position
                const frameToSeek = Math.floor(start * frameRate);
                videoPlayerRef.current.seekTo(frameToSeek);
              } else if (end !== oldEnd) {
                // Seek to end position
                const frameToSeek = Math.floor(end * frameRate);
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
          {formatTime(renderSettings.trimEnd || 0, 'hms_ms')}
        </span>
      </div>
    </div>
  );
};

export default TrimTimelineRow;
