import React from 'react';
import { useTranslation } from 'react-i18next';
import SubtitlePreviewList from './SubtitlePreviewList';

/**
 * Translation preview component with virtualized list
 * @param {Object} props - Component props
 * @param {Array} props.translatedSubtitles - Translated subtitles
 * @param {Array} props.targetLanguages - Target languages
 * @param {boolean} props.loadedFromCache - Whether translations were loaded from cache
 * @param {number} props.splitDuration - Split duration in minutes for segment calculation
 * @param {Function} props.onRetrySegment - Callback function to retry a specific segment
 * @returns {JSX.Element|null} - Rendered component or null if no translated subtitles
 */
const TranslationPreview = ({
  translatedSubtitles,
  targetLanguages,
  loadedFromCache,
  splitDuration = 0,
  onRetrySegment
}) => {
  const { t } = useTranslation();
  const [retryingSegments, setRetryingSegments] = React.useState(new Set());

  // Enhanced retry handler with loading state
  const handleRetrySegment = React.useCallback(async (segment) => {
    // Add segment to retrying set
    setRetryingSegments(prev => new Set(prev).add(segment.segmentNumber));

    try {
      // Call the original retry handler
      await onRetrySegment(segment);
    } finally {
      // Remove segment from retrying set
      setRetryingSegments(prev => {
        const newSet = new Set(prev);
        newSet.delete(segment.segmentNumber);
        return newSet;
      });
    }
  }, [onRetrySegment]);

  // Handler for individual subtitle retry
  const handleRetrySubtitle = React.useCallback(async (subtitleIndex) => {
    // Add subtitle to retrying set with the correct ID format
    const subtitleRetryId = `subtitle-${subtitleIndex + 1}`;
    setRetryingSegments(prev => new Set(prev).add(subtitleRetryId));

    try {
      // Create a single-subtitle segment for retry
      const singleSubtitleSegment = {
        segmentNumber: subtitleRetryId,
        startIndex: subtitleIndex,
        endIndex: subtitleIndex,
        subtitleCount: 1
      };

      // Call the original retry handler directly (not the wrapped one)
      await onRetrySegment(singleSubtitleSegment);
    } finally {
      // Remove subtitle from retrying set
      setRetryingSegments(prev => {
        const newSet = new Set(prev);
        newSet.delete(subtitleRetryId);
        return newSet;
      });
    }
  }, [onRetrySegment]);

  if (!translatedSubtitles || translatedSubtitles.length === 0) return null;

  return (
    <div className="translation-row preview-row">
      <div className="translation-preview translation-preview-animated">
        <div className="translation-preview-header">
          <h4>
            {t('translation.preview', 'Translation Preview')}
            {targetLanguages.length > 1
              ? ` (${targetLanguages.map(lang => lang.value).filter(val => val.trim() !== '').join(', ')})`
              : targetLanguages[0]?.value?.trim() ? ` (${targetLanguages[0].value})` : ''}
            {loadedFromCache && (
              <span className="cache-indicator" title={t('translation.fromCache', 'Loaded from cache')}>
                {"  "}
                <span className="material-symbols-rounded eco-icon" style={{ fontSize: '16px', marginLeft: '8px' }}>eco</span>
              </span>
            )}
          </h4>

          <div className="translation-preview-stats">
            <span>
              {(() => {
                const translationString = t('translation.totalSubtitles', 'Total: {{count}} subtitles', { count: translatedSubtitles.length });
                // Split to separate the part before count, the count, and everything after
                const match = translationString.match(/^(.*?)(\d+)(.*)$/);
                if (match) {
                  return (
                    <>
                      {match[1]}
                      <strong>{match[2]}{match[3]}</strong>
                    </>
                  );
                }
                return translationString; // Fallback if no match
              })()}
            </span>
          </div>
        </div>

        <SubtitlePreviewList
          translatedSubtitles={translatedSubtitles}
          splitDuration={splitDuration}
          onRetrySegment={handleRetrySegment}
          onRetrySubtitle={handleRetrySubtitle}
          retryingSegments={retryingSegments}
        />
      </div>
    </div>
  );
};

export default TranslationPreview;

