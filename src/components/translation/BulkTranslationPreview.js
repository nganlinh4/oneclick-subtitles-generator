import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import SubtitlePreviewList from './SubtitlePreviewList';



/**
 * Bulk translation preview component with file selection pills
 * @param {Object} props - Component props
 * @param {Array} props.bulkTranslations - Array of bulk translation results
 * @param {Array} props.targetLanguages - Target languages
 * @param {Object} props.mainTranslation - Main translation (if any)
 * @param {number} props.splitDuration - Split duration for segment calculation
 * @param {Function} props.onRetrySegment - Callback function to retry a specific segment
 * @returns {JSX.Element|null} - Rendered component or null if no translations
 */
const BulkTranslationPreview = ({
  bulkTranslations,
  targetLanguages,
  mainTranslation,
  splitDuration = 0,
  onRetrySegment
}) => {
  const { t } = useTranslation();
  const [retryingSegments, setRetryingSegments] = React.useState(new Set());

  // Get successful translations and include main translation if available
  const availableTranslations = useMemo(() => {
    const translations = [];
    
    // Add main translation first if available
    if (mainTranslation) {
      translations.push({
        id: 'main',
        name: mainTranslation.name,
        subtitles: mainTranslation.subtitles,
        loadedFromCache: mainTranslation.loadedFromCache,
        isMain: true
      });
    }

    // Add successful bulk translations
    bulkTranslations.forEach((bt, index) => {
      if (bt.success && bt.translatedSubtitles) {
        translations.push({
          id: `bulk-${index}`,
          name: bt.originalFile.name,
          subtitles: bt.translatedSubtitles,
          loadedFromCache: false,
          isMain: false
        });
      }
    });

    return translations;
  }, [bulkTranslations, mainTranslation]);

  // Selected translation state
  const [selectedTranslationId, setSelectedTranslationId] = useState(() => {
    return availableTranslations.length > 0 ? availableTranslations[0].id : null;
  });

  // Get currently selected translation
  const selectedTranslation = useMemo(() => {
    return availableTranslations.find(t => t.id === selectedTranslationId) || availableTranslations[0];
  }, [availableTranslations, selectedTranslationId]);

  // Enhanced retry handler with loading state for bulk translations
  const handleRetrySegment = React.useCallback(async (segment) => {
    if (!onRetrySegment || !selectedTranslation) return;

    // For bulk translations, we need to create a segment that references the correct file
    // and adjust indices to match the original subtitles from that specific file
    const bulkSegment = {
      ...segment,
      fileId: selectedTranslation.id,
      fileName: selectedTranslation.name,
      isFromBulk: true
    };

    // Add segment to retrying set with file-specific identifier
    const segmentId = `${selectedTranslation.id}-${segment.segmentNumber}`;
    setRetryingSegments(prev => new Set(prev).add(segmentId));

    try {
      // Call the original retry handler with bulk-specific segment info
      await onRetrySegment(bulkSegment);
    } finally {
      // Remove segment from retrying set
      setRetryingSegments(prev => {
        const newSet = new Set(prev);
        newSet.delete(segmentId);
        return newSet;
      });
    }
  }, [onRetrySegment, selectedTranslation]);

  // Handler for individual subtitle retry in bulk context
  const handleRetrySubtitle = React.useCallback(async (subtitleIndex) => {
    if (!selectedTranslation) return;

    // Create a single-subtitle segment for retry with file context
    const singleSubtitleSegment = {
      segmentNumber: `subtitle-${subtitleIndex + 1}`,
      startIndex: subtitleIndex,
      endIndex: subtitleIndex,
      subtitleCount: 1,
      fileId: selectedTranslation.id,
      fileName: selectedTranslation.name,
      isFromBulk: true
    };

    // Add subtitle to retrying set with file-specific identifier
    const subtitleRetryId = `${selectedTranslation.id}-subtitle-${subtitleIndex + 1}`;
    setRetryingSegments(prev => new Set(prev).add(subtitleRetryId));

    try {
      // Call the segment retry handler (which handles both segments and individual subtitles)
      await onRetrySegment(singleSubtitleSegment);
    } finally {
      // Remove subtitle from retrying set
      setRetryingSegments(prev => {
        const newSet = new Set(prev);
        newSet.delete(subtitleRetryId);
        return newSet;
      });
    }
  }, [onRetrySegment, selectedTranslation]);

  if (availableTranslations.length === 0) return null;

  return (
    <div className="translation-row preview-row">
      <div className="translation-preview translation-preview-animated">
        <div className="translation-preview-header">
          <h4>
            {t('translation.preview', 'Translation Preview')}
            {targetLanguages.length > 1
              ? ` (${targetLanguages.map(lang => lang.value).filter(val => val.trim() !== '').join(', ')})`
              : targetLanguages[0]?.value?.trim() ? ` (${targetLanguages[0].value})` : ''}
            {selectedTranslation?.loadedFromCache && (
              <span className="cache-indicator" title={t('translation.fromCache', 'Loaded from cache')}>
                {"  "}
                <span className="material-symbols-rounded eco-icon" style={{ fontSize: '16px', marginLeft: '8px' }}>eco</span>
              </span>
            )}
          </h4>

          <div className="translation-preview-stats">
            {selectedTranslation && <span>
              {(() => {
                const translationString = t('translation.totalSubtitles', 'Total: {{count}} subtitles', { count: selectedTranslation.subtitles.length });
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
            </span>}
          </div>
        </div>

        {/* File selection pills */}
        <div className="bulk-preview-selector">
          <div className="bulk-preview-pills">
            {availableTranslations.map((translation) => (
              <button
                key={translation.id}
                className={`bulk-preview-pill ${selectedTranslationId === translation.id ? 'active' : ''}`}
                onClick={() => setSelectedTranslationId(translation.id)}
                title={translation.name}
              >
                {translation.isMain && (
                  <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>star</span>
                )}
                <span className="pill-name">{translation.name}</span>
                <span className="pill-count">({translation.subtitles.length})</span>
              </button>
            ))}
          </div>
        </div>

        {/* Subtitle preview list */}
        {selectedTranslation && (
          <SubtitlePreviewList
            translatedSubtitles={selectedTranslation.subtitles}
            splitDuration={splitDuration}
            onRetrySegment={handleRetrySegment}
            onRetrySubtitle={handleRetrySubtitle}
            retryingSegments={retryingSegments}
            fileId={selectedTranslation.id}
          />
        )}
      </div>
    </div>
  );
};

export default BulkTranslationPreview;
