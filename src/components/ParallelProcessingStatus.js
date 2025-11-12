import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/ParallelProcessingStatus.css';
import SegmentRetryModal from './SegmentRetryModal';

/**
 * Component to display the status of parallel segment processing
 * @param {Object} props - Component props
 * @param {Array} props.segments - Array of segment status objects
 * @param {string} props.overallStatus - Overall processing status message
 * @param {string} props.statusType - Status type (loading, success, error, warning)
 * @param {Function} props.onRetrySegment - Function to retry processing a specific segment
 * @param {Function} props.onRetryWithModel - Function to retry processing a segment with a specific model
 * @param {Function} props.onGenerateSegment - Function to generate a specific segment (for strong model)
 * @param {Array} props.retryingSegments - Array of segment indices that are currently being retried
 * @param {Function} props.onViewRules - Function to open the transcription rules editor
 * @param {string} props.userProvidedSubtitles - User-provided subtitles for the whole media
 * @returns {JSX.Element} - Rendered component
 */
const ParallelProcessingStatus = ({
  segments,
  overallStatus,
  statusType,
  onRetrySegment,
  onRetryWithModel,
  onGenerateSegment,
  retryingSegments = [],
  onViewRules,
  userProvidedSubtitles = ''
 }) => {
  const { t } = useTranslation();

  // Remove debug translation logs to prevent console spam

  const [rulesAvailable, setRulesAvailable] = useState(false);
  const [showRetryModal, setShowRetryModal] = useState(false);
  const [selectedSegmentIndex, setSelectedSegmentIndex] = useState(null);

  // Check if transcription rules are available
  useEffect(() => {
    const checkRulesAvailability = async () => {
      try {
        // Dynamically import to avoid circular dependencies
        const { getTranscriptionRules } = await import('../utils/transcriptionRulesStore');
        const rules = getTranscriptionRules();
        setRulesAvailable(!!rules);
      } catch (error) {
        console.error('Error checking transcription rules availability:', error);
        setRulesAvailable(false);
      }
    };

    checkRulesAvailability();
  }, []);

  // No need for click outside handler since we don't have a dropdown anymore

  // Show status as toast instead of inline
  useEffect(() => {
    if (overallStatus) {
      const message = typeof overallStatus === 'string' ? (
        overallStatus.includes('cache') ? t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!') :
        overallStatus.includes('Video segments ready') ? t('output.segmentsReady', 'Video segments are ready for processing!') :
        overallStatus
      ) : 'Processing...';

      // Check if onboarding is active before showing toast
      const hasVisited = localStorage.getItem('has_visited_site') === 'true';
      const controlsDismissed = localStorage.getItem('onboarding_controls_dismissed') === 'true';
      const isOnboardingActive = !(hasVisited && controlsDismissed);

      if (!isOnboardingActive) {
        window.addToast(message, statusType || 'info', 5000, 'parallel-processing-status');
      }
    }
  }, [overallStatus, statusType, t]);

  if (!segments || segments.length === 0) {
    return null;
  }

  // Handle opening the retry modal
  const handleOpenRetryModal = (index) => {
    setSelectedSegmentIndex(index);
    setShowRetryModal(true);
  };

  // Handle retry with custom subtitles
  const handleRetryWithOptions = (segmentIndex, segments, options) => {
    onRetrySegment(segmentIndex, segments, options);
  };

  return (
    <div className="parallel-processing-container">

      {/* Segment Retry Modal */}
      {showRetryModal && selectedSegmentIndex !== null && (
        <SegmentRetryModal
          isOpen={showRetryModal}
          onClose={() => setShowRetryModal(false)}
          segmentIndex={selectedSegmentIndex}
          segments={segments}
          onRetry={handleRetryWithOptions}
          userProvidedSubtitles={userProvidedSubtitles}
        />
      )}

      <div className="segments-status">
        <div className="segments-status-header">
          <h4>{t('output.segmentsStatus', 'Segments Status')}</h4>
          {rulesAvailable && onViewRules && (
            <button
              className="view-rules-button"
              onClick={onViewRules}
              title={t('output.viewRules', 'View transcription rules')}
            >
              <span className="material-symbols-rounded">description</span>
              <span>{t('output.viewRules', 'View Rules')}</span>
            </button>
          )}
        </div>
        <div className="segments-grid">
          {segments.map((segment, index) => (
            <div
              key={index}
              className={`segment-status ${segment.status}`}
              title={segment.message}
            >
              <span className="segment-number">{index + 1}</span>
              <span className="segment-indicator"></span>
              <div className="segment-info">
                <span className="segment-message">
                  {segment.status === 'overloaded'
                    ? t('output.overloaded')
                    : (segment.shortMessage || (typeof segment.status === 'string' ? t(`output.${segment.status}`, segment.status) : 'Unknown status'))}
                </span>
                {segment.timeRange && (
                  <span className="segment-time-range">{segment.timeRange}</span>
                )}
              </div>
              {/* Show generate button for pending segments */}
              {segment.status === 'pending' && !retryingSegments.includes(index) && onGenerateSegment && (
                <button
                  className="segment-generate-btn"
                  onClick={(e) => {
                    e.stopPropagation();

                    onGenerateSegment(index);
                  }}
                  title={t('output.generateSegmentTooltip', 'Process this segment')}
                >
                  {t('output.generateSegment', 'Generate')}
                </button>
              )}

              {/* Show retry button for completed or overloaded segments that aren't currently being retried */}
              {(segment.status === 'success' || segment.status === 'error' || segment.status === 'overloaded') && !retryingSegments.includes(index) && onRetryWithModel && (
                <div className="model-retry-dropdown-container">
                  {/* Retry button - opens the modal directly */}
                  <div
                    className="segment-retry-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenRetryModal(index);
                    }}
                    title={t('output.retrySegment', 'Retry segment')}
                    role="button"
                    tabIndex="0"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        handleOpenRetryModal(index);
                      }
                    }}
                  >
                    <span className="material-symbols-rounded">refresh</span>
                  </div>
                </div>
              )}

              {/* Show spinning refresh icon for segments that are currently being retried */}
              {(segment.status === 'retrying' || retryingSegments.includes(index)) && (
                <span className="segment-retrying-indicator" title={t('output.retryingSegment', 'Retrying this segment...')}>
                  <span className="material-symbols-rounded spinning">refresh</span>
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ParallelProcessingStatus;
