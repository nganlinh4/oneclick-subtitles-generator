import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
// Removed PlayPauseMorphType4 import - replaced with simple material symbols
import '../../../utils/functionalScrollbar';
import { VariableSizeList as List } from 'react-window';
import { deriveSubtitleId, idsEqual } from '../../../utils/subtitle/idUtils';
import { enhanceF5TTSNarrations } from '../../../utils/narrationEnhancer';
import { hydrateNarrationResultsForAlignment } from '../../../utils/narrationAlignmentUtils';
import ResultRow from './ResultRow';
import { downloadAudio as downloadAudioFile, saveAudioToServer } from '../utils/narrationAudioDownload';
import useNarrationAudioSpeed from '../hooks/useNarrationAudioSpeed';


/**
 * Narration Results component
 * @param {Object} props - Component props
 * @param {Array} props.generationResults - Generation results
 * @param {Function} props.playAudio - Function to play audio
 * @param {Object} props.currentAudio - Current audio being played
 * @param {boolean} props.isPlaying - Whether audio is playing
 * @param {Function} props.getAudioUrl - Function to get audio URL
 * @param {Function} props.onRetry - Function to retry generation for a specific subtitle
 * @param {number|null} props.retryingSubtitleId - ID of the subtitle currently being retried
 * @param {Function} props.onRetryFailed - Function to retry all failed narrations
 * @returns {JSX.Element} - Rendered component
 */
const NarrationResults = ({
  generationResults,
  playAudio,
  currentAudio,
  isPlaying,
  getAudioUrl,
  onRetry,
  retryingSubtitleId,
  onRetryFailed,
  onGenerateAllPending,
  subtitleSource,
  isGenerating: _isGenerating,
  plannedSubtitles
}) => {
  const { t } = useTranslation();

  const listRef = useRef(null);
  const rowHeights = useRef({});

  // Speed/trim editing state + server API handlers
  const {
    itemDurations,
    fetchDurationsBatch,
    speedValue,
    setSpeedValue,
    isProcessing,
    processingProgress,
    itemSpeeds,
    setItemSpeed,
    itemProcessing,
    itemTrims,
    setItemTrim,
    modifyAudioSpeed,
    modifySingleAudioEditCombined
  } = useNarrationAudioSpeed({ generationResults, t });

  // Derive a displayed list that immediately shows the full "true" list during generation (like Gemini)
  const trueSubtitles = (() => {
    // If caller provided an explicit plan prop (even empty), treat it as source of truth
    if (typeof plannedSubtitles !== 'undefined') {
      return Array.isArray(plannedSubtitles) ? plannedSubtitles : [];
    }
    // Prefer grouped subtitles when enabled (from global state)
    if (typeof window !== 'undefined' && window.useGroupedSubtitles && Array.isArray(window.groupedSubtitles) && window.groupedSubtitles.length > 0) {
      return window.groupedSubtitles;
    }
    // Otherwise infer from selected source using globals populated elsewhere
    if (subtitleSource === 'translated' && typeof window !== 'undefined' && Array.isArray(window.translatedSubtitles) && window.translatedSubtitles.length > 0) {
      return window.translatedSubtitles;
    }
    if (typeof window !== 'undefined') {
      return window.originalSubtitles || window.subtitlesData || [];
    }
    return [];
  })();

  const displayedResults = (() => {
    // Always show all planned subtitles, with status based on generation results
    if (trueSubtitles.length > 0) {
      const completedIds = new Set();
      const failedIds = new Set();

      // Track completed and failed results
      if (generationResults && generationResults.length > 0) {
        generationResults.forEach(result => {
          if (result.success) {
            completedIds.add(result.subtitle_id);
          } else if (!result.pending) {
            failedIds.add(result.subtitle_id);
          }
        });
      }

      // Create results for all subtitles
      const results = trueSubtitles.map((subtitle, index) => {
        const subtitleId = deriveSubtitleId(subtitle, index);
        const existingResult = generationResults?.find(r => idsEqual(r.subtitle_id, subtitleId));

        if (existingResult) {
          // Use existing result
          return existingResult;
        } else {
          // Create pending result
          return {
            subtitle_id: subtitleId,
            text: subtitle.text || '',
            success: false,
            pending: true,
            start: subtitle.start,
            end: subtitle.end,
            original_ids: subtitle.original_ids || (subtitle.id ? [subtitle.id] : [])
          };
        }
      });

  // Preserve planned order to keep alignment with timeline after edits/deletes
  return results;
    }

    // Fallback: show generation results if no planned subtitles
    return generationResults || [];
  })();

  // Stable key derived from filenames to avoid re-render loops
  // (displayedResults is a new array every render, so we derive a string key instead)
  const durationFetchKey = (displayedResults || [])
    .map(r => r && r.filename)
    .filter(Boolean)
    .join(',');

  // Load durations for both main files and their trim backups
  useEffect(() => {
    if (!durationFetchKey) return;

    const getBackupName = (fn) => {
      if (!fn) return null;
      const lastSlash = fn.lastIndexOf('/');
      const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
      const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
      return `${dir ? dir + '/' : ''}backup_${base}`;
    };

    const filenames = durationFetchKey.split(',');
    const backupFilenames = filenames.map(getBackupName).filter(Boolean);
    const allFilenames = [...new Set([...filenames, ...backupFilenames])];

    fetchDurationsBatch(allFilenames);
  }, [durationFetchKey, fetchDurationsBatch]);

  // Download audio as WAV file
  const downloadAudio = (result) => downloadAudioFile(result, getAudioUrl, t);

  // Check if there are any failed narrations (exclude pending items)
  const hasFailedNarrations = generationResults && generationResults.some(result => !result.success && !result.pending);

  // Check if there are any pending narrations
  const hasPendingNarrations = displayedResults && displayedResults.some(result => result.pending);

  // Function to calculate row height based on explicit line breaks only (stable like LyricsDisplay)
  const getRowHeight = (index) => {
    // Return cached height if available
    if (rowHeights.current[index] !== undefined) return rowHeights.current[index];

    const result = displayedResults[index];
    if (!result) return 60; // Default height for a single-line item with controls

    // Only count explicit line breaks to avoid jitter from soft-wrap estimation
    const text = result.text || '';
    const lineCount = Math.max(1, text.split('\n').length);

    // Base height + additional height per extra line
    const height = 60 + (lineCount - 1) * 20;

    // Cache the calculated height
    rowHeights.current[index] = height;
    return height;
  };

  // Reset row heights when results change
  useEffect(() => {
    rowHeights.current = {};
    if (listRef.current) {
      listRef.current.resetAfterIndex(0);
    }

    // Save narrations to file system when they change
    if (generationResults && generationResults.length > 0) {
      try {
        // Process each narration result that has audioData but no filename
        const savePromises = generationResults
          .filter(result => result.success && result.audioData && !result.filename)
          .map(async (result) => {
            const filename = await saveAudioToServer(result);
            if (filename) {
              // Update the result with the filename
              result.filename = filename;
              // Remove the audioData to save memory once it's saved to the server
              delete result.audioData;
            }
            return result;
          });

        // Wait for all save operations to complete
        Promise.all(savePromises)
          .then(updatedResults => {
            if (updatedResults.length > 0) {
              // Get subtitles from window object for enhancing narrations with timing information
              const subtitles = window.originalSubtitles || window.subtitlesData || [];

              // Enhance narrations with timing information from subtitles
              const enhancedResults = enhanceF5TTSNarrations(generationResults, subtitles);
              const resultsWithFilenames = hydrateNarrationResultsForAlignment(enhancedResults);

              // Update window.originalNarrations with enhanced results for alignment
              window.originalNarrations = [...resultsWithFilenames];

              // Dispatch an event to notify other components that narrations have been updated
              const event = new CustomEvent('narrations-updated', {
                detail: {
                  source: 'original', // Assuming F5-TTS narrations are for original subtitles
                  narrations: resultsWithFilenames
                }
              });
              window.dispatchEvent(event);
            }
          })
          .catch(error => {
            console.error('Error saving F5-TTS narrations to server:', error);
          });

      } catch (error) {
        console.error('Error processing F5-TTS narrations for saving:', error);
      }
    }
  }, [generationResults]);



  return (
    <div className="results-section">
      <style dangerouslySetInnerHTML={{ __html: `.trim-slider .standard-slider-active-track .track, .trim-slider .standard-slider-inactive-track .track { height: 10px; } .range-slider .standard-slider-handle { height: 24px; }` }} />
      <div className="results-header">
        <h4>{t('narration.results', 'Generated Narration')}</h4>

        {/* Generate All Pending Narrations button */}
        {hasPendingNarrations && onGenerateAllPending && (
          <button
            className="pill-button secondary generate-all-pending-button"
            onClick={onGenerateAllPending}
            disabled={retryingSubtitleId !== null}
            title={t('narration.generateAllPendingTooltip', 'Generate all pending narrations')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>build</span>
            {t('narration.generateAllPending', 'Generate All Pending')}
          </button>
        )}

        {/* Retry Failed Narrations button */}
        {hasFailedNarrations && onRetryFailed && (
          <button
            className="pill-button secondary retry-failed-button"
            onClick={onRetryFailed}
            disabled={retryingSubtitleId !== null}
            title={t('narration.retryFailedTooltip', 'Retry all failed narrations')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>refresh</span>
            {t('narration.retryFailed', 'Retry Failed Narrations')}
          </button>
        )}

        {/* Speed Control Slider */}
        {generationResults && generationResults.length > 0 && (
          <div className="speed-control-container">
            <span className="speed-control-label">{t('narration.speed', 'Speed')}:</span>
            <SliderWithValue
              value={speedValue}
              onChange={(value) => setSpeedValue(parseFloat(value))}
              min={0.5}
              max={2.0}
              step={0.01}
              orientation="Horizontal"
              size="XSmall"
              state={isProcessing ? "Disabled" : "Enabled"}
              width="compact"
              className="standard-slider-container width-compact orientation-horizontal size-XSmall state-Enabled speed-control-slider"
              style={{ width: '150px' }}
              id="narration-speed-control"
              ariaLabel={t('narration.speed', 'Speed')}
              formatValue={(v) => `${Number(v).toFixed(2)}x`}
            />
            {isProcessing ? (
              <div className="speed-control-progress">
                <div className="speed-control-spinner"></div>
                <div className="speed-control-progress-info">
                  <span>{processingProgress.current}/{processingProgress.total}</span>

                </div>
              </div>
            ) : (
              <button
                className="speed-control-apply-button"
                onClick={modifyAudioSpeed}
                disabled={!generationResults || generationResults.length === 0}
              >
                {t('narration.apply', 'Apply')}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="results-list">
        {displayedResults.length === 0 ? (
          <div className="no-results-message">
            {t('narration.waitingForResults', 'Waiting for narration results...')}
          </div>
        ) : (
          // Use virtualized list for better performance with large datasets
          <List
            ref={listRef}
            className="results-virtualized-list"
            height={700} // Increased height for the F5-TTS virtualized container to show more results
            width="100%"
            itemCount={displayedResults.length}
            itemSize={getRowHeight} // Dynamic row heights based on content
            overscanCount={18} // Increase overscan to reduce blanking during fast scrolls
            itemKey={(index, data) => {
              const item = data.generationResults[index];
              const id = item && item.subtitle_id;
              // Ensure uniqueness even if upstream repeats subtitle_id
              return (id !== undefined && id !== null) ? `${id}-${index}` : index;
            }}
            itemData={{
              generationResults: displayedResults,
              onRetry,
              retryingSubtitleId,
              currentAudio,
              isPlaying,
              playAudio,
              getAudioUrl,
              downloadAudio,
              // per-item trim and speed control
              itemTrims,
              setItemTrim,
              itemSpeeds,
              setItemSpeed,
              modifySingleAudioEditCombined,
              itemProcessing,
              itemDurations,
              t
            }}
          >
            {ResultRow}
          </List>
        )}
      </div>
    </div>
  );
};

export default NarrationResults;
