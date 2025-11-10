import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../common/SliderWithValue';
import HelpIcon from '../common/HelpIcon';


/**
 * Split duration slider component
 * @param {Object} props - Component props
 * @param {number} props.splitDuration - Current split duration value
 * @param {Function} props.onSplitDurationChange - Function to handle split duration change
 * @param {Array} props.subtitles - Subtitles array for segment distribution calculation
 * @param {boolean} props.disabled - Whether the slider is disabled
 * @returns {JSX.Element} - Rendered component
 */
const SplitDurationSlider = ({ splitDuration, onSplitDurationChange, subtitles, disabled = false }) => {
  const { t } = useTranslation();

  // Calculate segment distribution with time ranges based on split duration
  const segmentDistribution = useMemo(() => {
    if (!subtitles || subtitles.length === 0 || splitDuration === 0) {
      // No split, all subtitles in one segment
      const totalCount = subtitles?.length || 0;
      const startTime = subtitles?.[0]?.start || 0;
      const endTime = subtitles?.[subtitles.length - 1]?.end || 0;
      return [{ count: totalCount, startTime, endTime }];
    }

    // Convert splitDuration from minutes to seconds
    const splitDurationSeconds = splitDuration * 60;

    // Group subtitles into chunks based on their timestamps
    const chunks = [];
    let currentChunk = [];
    let chunkStartTime = subtitles[0]?.start || 0;

    subtitles.forEach(subtitle => {
      // If this subtitle would exceed the chunk duration, start a new chunk
      if (subtitle.start - chunkStartTime > splitDurationSeconds) {
        if (currentChunk.length > 0) {
          chunks.push({
            count: currentChunk.length,
            startTime: currentChunk[0].start,
            endTime: currentChunk[currentChunk.length - 1].end
          });
          currentChunk = [];
          chunkStartTime = subtitle.start;
        }
      }

      currentChunk.push(subtitle);
    });

    // Add the last chunk if it's not empty
    if (currentChunk.length > 0) {
      chunks.push({
        count: currentChunk.length,
        startTime: currentChunk[0].start,
        endTime: currentChunk[currentChunk.length - 1].end
      });
    }

    return chunks.length > 0 ? chunks : [{ count: subtitles.length, startTime: subtitles[0]?.start || 0, endTime: subtitles[subtitles.length - 1]?.end || 0 }];
  }, [subtitles, splitDuration]);

  // Helper function to format time for display
  const formatTime = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="translation-row split-duration-row">
      <div className="row-label">
        <label>{t('translation.splitDuration', 'Split Duration')}:</label>
      </div>
      <div className="row-content">
        {/* Slider control row with help icon */}
        <div className="slider-control-row">
          <SliderWithValue
            value={splitDuration}
            onChange={(value) => onSplitDurationChange(parseInt(value))}
            min={0}
            max={20}
            step={1}
            orientation="Horizontal"
            size="XSmall"
            state={disabled ? "Disabled" : "Enabled"}
            className="split-duration-slider"
            id="split-duration-slider"
            ariaLabel={t('translation.splitDuration', 'Split Duration')}
            formatValue={(v) => v === 0 ? t('translation.noSplit', 'No Split') : `${v} ${t('translation.minutes', 'min')}`}
          >
            {/* Help icon next to slider value */}
            <HelpIcon
              title={t('translation.splitDurationHelp', 'Splitting subtitles into smaller chunks helps prevent translations from being cut off due to token limits. For longer videos, use smaller chunks.')}
            />
          </SliderWithValue>
        </div>

        {/* Compact segment distribution preview - bottom full width */}
        {subtitles && subtitles.length > 0 && (
          <div className="segment-preview-compact">
            {splitDuration === 0 ? (
              <span className="single-segment">
                {t('translation.allSubtitles', 'All {{count}} subtitles', {count: subtitles.length})}
              </span>
            ) : (
              <div className="segment-pills">
                {segmentDistribution.map((segment, index) => (
                  <span
                    key={index}
                    className="segment-pill"
                    title={`${t('translation.segment', 'Segment')} ${index + 1}: ${formatTime(segment.startTime)} - ${formatTime(segment.endTime)}`}
                  >
                    {segment.count}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default SplitDurationSlider;
