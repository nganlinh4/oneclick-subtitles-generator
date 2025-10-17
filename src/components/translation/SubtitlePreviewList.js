import React, { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { VariableSizeList as List } from 'react-window';
import LoadingIndicator from '../common/LoadingIndicator';
import formatTimeString from './utils/formatTimeString';

/**
 * Calculate segments based on split duration and subtitles
 * @param {Array} subtitles - Array of subtitles
 * @param {number} splitDuration - Split duration in minutes (0 = no split)
 * @returns {Array} - Array of segment info objects
 */
const calculateSegments = (subtitles, splitDuration) => {
  if (!splitDuration || splitDuration === 0 || !subtitles || subtitles.length === 0) {
    // No splitting - all subtitles are in one segment
    return [{
      segmentNumber: 1,
      startIndex: 0,
      endIndex: subtitles.length - 1,
      subtitleCount: subtitles.length
    }];
  }

  const splitDurationSeconds = splitDuration * 60;
  const segments = [];
  let currentSegment = 1;
  let segmentStartIndex = 0;
  let chunkStartTime = subtitles[0]?.start || 0;

  for (let i = 0; i < subtitles.length; i++) {
    const subtitle = subtitles[i];
    
    // Check if this subtitle would exceed the chunk duration
    if (subtitle.start - chunkStartTime > splitDurationSeconds && i > segmentStartIndex) {
      // End current segment
      segments.push({
        segmentNumber: currentSegment,
        startIndex: segmentStartIndex,
        endIndex: i - 1,
        subtitleCount: i - segmentStartIndex
      });
      
      // Start new segment
      currentSegment++;
      segmentStartIndex = i;
      chunkStartTime = subtitle.start;
    }
  }

  // Add the last segment
  if (segmentStartIndex < subtitles.length) {
    segments.push({
      segmentNumber: currentSegment,
      startIndex: segmentStartIndex,
      endIndex: subtitles.length - 1,
      subtitleCount: subtitles.length - segmentStartIndex
    });
  }

  return segments;
};

/**
 * Individual subtitle row component for virtualized list
 */
const SubtitleRow = ({ index, style, data }) => {
  const { t } = useTranslation();
  const { translatedSubtitles, segments, onRetrySegment, onRetrySubtitle, retryingSegments, fileId } = data;
  const subtitle = translatedSubtitles[index];

  // Find which segment this subtitle belongs to
  const currentSegment = segments.find(segment =>
    index >= segment.startIndex && index <= segment.endIndex
  );

  // Check if this is the first subtitle in the segment (for merged cell display)
  const isFirstInSegment = currentSegment && index === currentSegment.startIndex;

  // Check if this segment is currently being retried
  // For bulk translations, check with file-specific segment ID
  const segmentRetryId = fileId ? `${fileId}-${currentSegment?.segmentNumber}` : currentSegment?.segmentNumber;
  const isRetrying = currentSegment && retryingSegments && retryingSegments.has(segmentRetryId);

  // Check if this individual subtitle is being retried
  // For bulk translations, check with file-specific subtitle ID
  const subtitleRetryId = fileId ? `${fileId}-subtitle-${index + 1}` : `subtitle-${index + 1}`;
  const isSubtitleRetrying = retryingSegments && retryingSegments.has(subtitleRetryId);

  // Determine the time display format - always format properly
  let startTimeDisplay, endTimeDisplay;

  // Prioritize formatted time strings, but ensure proper formatting
  if (subtitle.startTime && typeof subtitle.startTime === 'string') {
    startTimeDisplay = subtitle.startTime;
  } else if (subtitle.start !== undefined) {
    startTimeDisplay = formatTimeString(subtitle.start);
  } else {
    startTimeDisplay = '00:00:00.000';
  }

  if (subtitle.endTime && typeof subtitle.endTime === 'string') {
    endTimeDisplay = subtitle.endTime;
  } else if (subtitle.end !== undefined) {
    endTimeDisplay = formatTimeString(subtitle.end);
  } else {
    endTimeDisplay = '00:00:05.000';
  }

  return (
    <div 
      style={style} 
      className={`preview-subtitle-row ${isRetrying || isSubtitleRetrying ? 'retrying' : ''}`}
      role="row"
      aria-label={`${t('translation.subtitle', 'Subtitle')} ${index + 1}`}
      data-segment-number={currentSegment?.segmentNumber}
      data-segment-odd={currentSegment?.segmentNumber ? (currentSegment.segmentNumber % 2 === 1).toString() : 'true'}
      data-is-first-in-segment={isFirstInSegment ? 'true' : 'false'}
    >
      {/* Segment column - always present for consistent layout */}
      <div className="preview-segment-sticky" role="gridcell">
        {/* Only show segment content for first subtitle in segment */}
        {isFirstInSegment && (
          <div className="segment-content">
            <div className="segment-label">
              {t('translation.segment', 'Seg')} {currentSegment.segmentNumber}
            </div>
            <button 
              className={`segment-retry-btn ${isRetrying ? 'loading' : ''}`}
              onClick={() => onRetrySegment && onRetrySegment(currentSegment)}
              title={t('translation.retrySegment', 'Retry Segment')}
              disabled={isRetrying}
              aria-label={t('translation.retrySegment', 'Retry Segment')}
            >
              {isRetrying ? (
                <LoadingIndicator 
                  size={14}
                  showContainer={false} 
                  theme="light"
                  className="segment-loading"
                />
              ) : (
                <span className="material-symbols-rounded retry-icon" style={{ fontSize: '14px' }}>refresh</span>
              )}
            </button>
          </div>
        )}
        {/* Show segment indicator line for non-first rows */}
        {!isFirstInSegment && currentSegment && (
          <div className="segment-indicator">
            <div className={`segment-line ${isRetrying ? 'pulsing' : ''}`}></div>
          </div>
        )}
      </div>
      
      <div className="preview-number-sticky" role="gridcell">
        <span className="subtitle-number" aria-label={`${t('translation.subtitleNumber', 'Subtitle number')} ${index + 1}`}>
          {index + 1}
        </span>
        <button 
          className={`subtitle-retry-btn ${isSubtitleRetrying ? 'loading' : ''}`}
          onClick={() => onRetrySubtitle && onRetrySubtitle(index)}
          title={t('translation.retrySubtitle', 'Retry this subtitle')}
          disabled={isSubtitleRetrying}
          aria-label={t('translation.retrySubtitle', 'Retry this subtitle')}
        >
          {isSubtitleRetrying ? (
            <LoadingIndicator 
              size={10} 
              showContainer={false} 
              theme="light"
              className="subtitle-loading"
            />
          ) : (
            <span className="material-symbols-rounded retry-icon" style={{ fontSize: '10px' }}>refresh</span>
          )}
        </button>
      </div>
      <div className="preview-content" role="gridcell">
        <span className="preview-time" aria-label={`${t('translation.timeRange', 'Time range')}: ${startTimeDisplay} ${t('common.to', 'to')} ${endTimeDisplay}`}>
          {startTimeDisplay} → {endTimeDisplay}
        </span>
        <span className="preview-text" aria-label={`${t('translation.subtitleText', 'Subtitle text')}`}>
          {subtitle.text.split('\n').map((line, lineIndex) => (
            <React.Fragment key={lineIndex}>
              {lineIndex > 0 && <br />}
              {line}
            </React.Fragment>
          ))}
        </span>
        {(isRetrying || isSubtitleRetrying) && (
          <div className="retry-overlay">
            <LoadingIndicator 
              size={20} 
              showContainer={false} 
              theme="dark"
              className="retry-overlay-loading"
            />
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Shared subtitle preview list component with all features
 * @param {Object} props - Component props
 * @param {Array} props.translatedSubtitles - Translated subtitles
 * @param {number} props.splitDuration - Split duration in minutes for segment calculation
 * @param {Function} props.onRetrySegment - Callback function to retry a specific segment
 * @param {Function} props.onRetrySubtitle - Callback function to retry a specific subtitle
 * @param {Set} props.retryingSegments - Set of segment numbers currently being retried
 * @param {string} props.fileId - Optional file ID for bulk translation context
 * @returns {JSX.Element|null} - Rendered component or null if no translated subtitles
 */
const SubtitlePreviewList = ({
  translatedSubtitles,
  splitDuration = 0,
  onRetrySegment,
  onRetrySubtitle,
  retryingSegments = new Set(),
  fileId = null
}) => {
  const { t } = useTranslation();
  const listRef = useRef(null);

  // Calculate segments based on split duration
  const segments = useMemo(() => {
    return calculateSegments(translatedSubtitles, splitDuration);
  }, [translatedSubtitles, splitDuration]);

  // Calculate dynamic row height based on content
  const getRowHeight = React.useCallback((index) => {
    const subtitle = translatedSubtitles[index];
    if (!subtitle) return 70; // Default height

    const text = subtitle.text || '';
    
    // Base height for row structure (time display + padding)
    const baseHeight = 50; // Reduced base height
    
    // Count explicit line breaks
    const lineBreaks = (text.match(/\n/g) || []).length;
    
    // For text wrapping estimation, be more conservative
    const avgCharsPerLine = 80; // Increased chars per line
    const textWithoutBreaks = text.replace(/\n/g, '');
    const estimatedWrappedLines = Math.max(1, Math.ceil(textWithoutBreaks.length / avgCharsPerLine));
    
    // Total lines = 1 (base) + explicit breaks + additional wrapped lines
    const totalLines = 1 + lineBreaks + (estimatedWrappedLines - 1);
    
    // Each line needs exactly 20px (font-size 0.95rem * line-height 1.4 ≈ 20px)
    const textHeight = totalLines * 20;
    
    return baseHeight + textHeight;
  }, [translatedSubtitles]);

  // Memoize the item data to prevent unnecessary re-renders
  const itemData = useMemo(() => ({
    translatedSubtitles: translatedSubtitles || [],
    segments,
    onRetrySegment,
    onRetrySubtitle,
    retryingSegments,
    fileId
  }), [translatedSubtitles, segments, onRetrySegment, onRetrySubtitle, retryingSegments, fileId]);

  if (!translatedSubtitles || translatedSubtitles.length === 0) return null;

  return (
    <div 
      className="translation-preview-virtualized"
      role="grid"
      aria-label={t('translation.subtitleList', 'Subtitle list')}
    >
      <List
        ref={listRef}
        className="translation-preview-list"
        height={400} // Fixed height for the virtualized container
        width="100%"
        itemCount={translatedSubtitles.length}
        itemSize={getRowHeight}
        itemData={itemData}
        overscanCount={5} // Number of items to render outside visible area
      >
        {SubtitleRow}
      </List>
    </div>
  );
};

export default SubtitlePreviewList;
