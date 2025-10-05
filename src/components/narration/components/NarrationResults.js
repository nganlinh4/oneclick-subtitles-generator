import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import LoadingIndicator from '../../common/LoadingIndicator';
import '../../../utils/functionalScrollbar';
import { VariableSizeList as List } from 'react-window';
import { SERVER_URL } from '../../../config';
import { enhanceF5TTSNarrations } from '../../../utils/narrationEnhancer';

// Constants for localStorage keys
const CURRENT_VIDEO_ID_KEY = 'current_video_url';
const CURRENT_FILE_ID_KEY = 'current_file_cache_id';

/**
 * Virtualized row renderer for F5-TTS narration results
 */
const ResultRow = ({ index, style, data }) => {
  const {
    generationResults,
    onRetry,
    retryingSubtitleId,
    currentAudio,
    isPlaying,
    playAudio,
    downloadAudio,
    t
  } = data;

  const result = generationResults[index];
  const subtitle_id = result.subtitle_id;

  return (
    <div
      style={style}
      className={`result-item
        ${result.success ? '' : result.pending ? 'pending' : 'failed'}
        ${currentAudio && currentAudio.id === subtitle_id ? 'playing' : ''}
        ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
    >
      <div className="result-text hide-native-scrollbar">
        {/* Display 1-based row number for user-friendly sequential numbering */}
        <span className="result-id">{index + 1}.</span>
        {result.text}
      </div>

      <div className="result-controls">
        {result.pending ? (
          <>
            <span className="status-message pending">
              {t('narration.pending', 'Pending generation...')}
            </span>
            {onRetry && (
              <button
                className={`pill-button secondary generate-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={() => onRetry(subtitle_id)}
                title={t('narration.generate', 'Generate this narration')}
                disabled={retryingSubtitleId === subtitle_id}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <>
                    <LoadingIndicator
                      theme="dark"
                      showContainer={false}
                      size={14}
                      className="generate-loading-indicator"
                    />
                    {t('narration.generating', 'Generating...')}
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
                    </svg>
                    {t('narration.generate', 'Generate')}
                  </>
                )}
              </button>
            )}
          </>
        ) : result.success ? (
          <>
            <button
              className="pill-button primary"
              onClick={() => playAudio(result)}
            >
              {currentAudio && currentAudio.id === subtitle_id && isPlaying ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="4" width="4" height="16" fill="currentColor" />
                    <rect x="14" y="4" width="4" height="16" fill="currentColor" />
                  </svg>
                  {t('narration.pause', 'Pause')}
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
                  </svg>
                  {t('narration.play', 'Play')}
                </>
              )}
            </button>
            <button
              className="pill-button secondary"
              onClick={() => downloadAudio(result)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t('narration.download', 'Download')}
            </button>
            {onRetry && (
              <button
                className={`pill-button secondary retry-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={() => onRetry(subtitle_id)}
                title={t('narration.retry', 'Retry generation')}
                disabled={retryingSubtitleId === subtitle_id}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <>
                    <LoadingIndicator
                      theme="dark"
                      showContainer={false}
                      size={14}
                      className="retry-loading-indicator"
                    />
                    {t('narration.retrying', 'Retrying...')}
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 4v6h6" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    {t('narration.retry', 'Retry')}
                  </>
                )}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="error-message">
              {t('narration.failed', 'Generation failed')}
            </span>
            {onRetry && (
              <button
                className={`pill-button secondary retry-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={() => onRetry(subtitle_id)}
                title={t('narration.retry', 'Retry generation')}
                disabled={retryingSubtitleId === subtitle_id}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <>
                    <LoadingIndicator
                      theme="dark"
                      showContainer={false}
                      size={14}
                      className="retry-loading-indicator"
                    />
                    {t('narration.retrying', 'Retrying...')}
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 4v6h6" />
                      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                    </svg>
                    {t('narration.retry', 'Retry')}
                  </>
                )}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

/**
 * Helper function to get current media ID (either YouTube URL or file ID)
 */
const getCurrentMediaId = () => {
  const youtubeUrl = localStorage.getItem(CURRENT_VIDEO_ID_KEY);
  const fileId = localStorage.getItem(CURRENT_FILE_ID_KEY);
  return youtubeUrl || fileId || null;
};

/**
 * Helper function to generate a simple hash of subtitles for cache validation
 */
const generateSubtitleHash = (results) => {
  if (!results || !results.length) return '';

  // Create a string of all subtitle IDs and text
  const subtitleString = results.map(r => `${r.subtitle_id}:${r.text}`).join('|');

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < subtitleString.length; i++) {
    const char = subtitleString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
};

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
  subtitleSource,
  isGenerating,
  plannedSubtitles
}) => {
  const { t } = useTranslation();

  const listRef = useRef(null);
  const rowHeights = useRef({});
  const [loadedFromCache, setLoadedFromCache] = useState(false);

  // Derive a displayed list that immediately shows the full "true" list during generation (like Gemini)
  const trueSubtitles = (() => {
    // If caller provided an explicit plan, always prefer it
    if (Array.isArray(plannedSubtitles) && plannedSubtitles.length > 0) {
      return plannedSubtitles;
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

  const displayedResults = (generationResults && generationResults.length > 0)
    ? generationResults
    : (isGenerating && trueSubtitles.length > 0
        ? trueSubtitles.map((s, i) => ({
            subtitle_id: s.id ?? s.subtitle_id ?? (i + 1),
            text: s.text || '',
            success: false,
            pending: true,
            start: s.start,
            end: s.end,
            original_ids: s.original_ids || (s.id ? [s.id] : [])
          }))
        : []);

  // Speed control state
  const [speedValue, setSpeedValue] = useState(1.0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [currentFile, setCurrentFile] = useState('');

  // Download audio as WAV file
  const downloadAudio = (result) => {
    if (result.filename) {
      try {


        // Get the audio URL
        const audioUrl = getAudioUrl(result.filename);


        // Use fetch to get the file as a blob
        fetch(audioUrl)
          .then(response => {
            if (!response.ok) {
              throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
            }
            return response.blob();
          })
          .then(blob => {
            // Create a blob URL
            const blobUrl = URL.createObjectURL(blob);

            // Create a download link
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `narration_${result.subtitle_id}.wav`;
            a.style.display = 'none';
            document.body.appendChild(a);

            // Trigger the download
            a.click();

            // Clean up
            setTimeout(() => {
              document.body.removeChild(a);
              URL.revokeObjectURL(blobUrl);
            }, 100);


          })
          .catch(error => {
            console.error('Error downloading audio file:', error);
            alert(t('narration.downloadError', `Error downloading audio file: ${error.message}`));
          });
      } catch (error) {
        console.error('Error initiating download:', error);
        alert(t('narration.downloadError', `Error initiating download: ${error.message}`));
      }
    } else {
      console.error('No filename available for download');
      alert(t('narration.downloadError', 'No audio file available for download'));
    }
  };

  // Speed modification function
  const modifyAudioSpeed = async () => {
    if (!generationResults || generationResults.length === 0) {
      console.log('No narration results to modify');
      return;
    }

    // Filter successful narrations
    const successfulNarrations = generationResults.filter(result => result.success && result.filename);

    if (successfulNarrations.length === 0) {
      console.log('No successful narrations to modify');
      return;
    }

    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: successfulNarrations.length });
    setCurrentFile('');

    try {
      console.log(`Modifying speed of ${successfulNarrations.length} narration files to ${speedValue}x`);

      // Use batch endpoint to process all files at once
      const apiUrl = `${SERVER_URL}/api/narration/batch-modify-audio-speed`;
      console.log(`Sending request to: ${apiUrl}`);

      // Use fetch with streaming response to get real-time progress updates
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filenames: successfulNarrations.map(result => result.filename),
          speedFactor: speedValue
        })
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      // Read the streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.status === 'progress') {
                setProcessingProgress({ current: data.current, total: data.total });
                setCurrentFile(data.filename || '');
              } else if (data.status === 'completed') {
                console.log('Speed modification completed successfully');
                setProcessingProgress({ current: data.total, total: data.total });
                setCurrentFile('');
              } else if (data.status === 'error') {
                throw new Error(data.error || 'Unknown error occurred');
              }
            } catch (parseError) {
              console.error('Error parsing progress data:', parseError);
            }
          }
        }
      }

      console.log('All files processed successfully');
    } catch (error) {
      console.error('Error modifying audio speed:', error);
      alert(t('narration.speedModificationError', `Error modifying audio speed: ${error.message}`));
    } finally {
      setIsProcessing(false);
      setProcessingProgress({ current: 0, total: 0 });
      setCurrentFile('');
    }
  };

  // Check if there are any failed narrations
  const hasFailedNarrations = generationResults && generationResults.some(result => !result.success);

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

  // Function to save audio to server
  const saveAudioToServer = async (result) => {
    if (!result || !result.audioData) return null;

    try {
      // Send the audio data to the server
      const response = await fetch(`${SERVER_URL}/api/narration/save-f5tts-audio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioData: result.audioData,
          subtitle_id: result.subtitle_id,
          sampleRate: result.sampleRate || 24000,
          mimeType: result.mimeType || 'audio/pcm'
        })
      });

      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();

      if (data.success) {
        // Return the filename
        return data.filename;
      } else {
        throw new Error(data.error || 'Unknown error saving audio to server');
      }
    } catch (error) {
      console.error(`Error saving audio for subtitle ${result.subtitle_id}:`, error);
      return null;
    }
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

              // Make sure all narrations have the filename property set
              // This is critical for the "Refresh Narration" button to work
              const resultsWithFilenames = enhancedResults.map(result => {
                // If the result already has a filename, use it
                if (result.filename) {
                  return result;
                }

                // If the result doesn't have a filename but has audioData, it means
                // we're still in the process of saving it to the server
                if (result.audioData) {
                  console.warn(`Narration for subtitle ${result.subtitle_id} has audioData but no filename yet`);
                  return result;
                }

                // If the result has neither filename nor audioData, it's likely a failed narration
                if (!result.success) {
                  return result;
                }

                // For any other case, construct a default filename based on the subtitle_id
                return {
                  ...result,
                  filename: `subtitle_${result.subtitle_id}/f5tts_1.wav`
                };
              });

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

  // We no longer need to load narrations from localStorage cache
  // The narrations will be loaded from the file system by the parent component
  // This useEffect is kept as a placeholder for future enhancements
  useEffect(() => {
    // Only try to load if we don't have results yet
    if (generationResults && generationResults.length > 0) return;

    // No need to do anything here - narrations are loaded from the file system
    // by the parent component (UnifiedNarrationSection.js)
  }, [generationResults]);

  // Listen for narrations-updated event to update the component
  useEffect(() => {
    const handleNarrationsUpdated = (event) => {
      if (event.detail && event.detail.narrations && event.detail.fromCache) {

        // Reset loading state since we now have the narrations
        setLoadedFromCache(false);
      }
    };

    // Add event listener
    window.addEventListener('narrations-updated', handleNarrationsUpdated);

    // Clean up
    return () => {
      window.removeEventListener('narrations-updated', handleNarrationsUpdated);
    };
  }, []);

  return (
    <div className="results-section">
      <div className="results-header">
        <h4>{t('narration.results', 'Generated Narration')}</h4>

        {/* Retry Failed Narrations button */}
        {hasFailedNarrations && onRetryFailed && (
          <button
            className="pill-button secondary retry-failed-button"
            onClick={onRetryFailed}
            disabled={retryingSubtitleId !== null}
            title={t('narration.retryFailedTooltip', 'Retry all failed narrations')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v6h6" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
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
              step={0.1}
              orientation="Horizontal"
              size="XSmall"
              state={isProcessing ? "Disabled" : "Enabled"}
              width="compact"
              className="speed-control-slider"
              id="narration-speed-control"
              ariaLabel={t('narration.speed', 'Speed')}
              formatValue={(v) => `${Number(v).toFixed(1)}x`}
            />
            {isProcessing ? (
              <div className="speed-control-progress">
                <div className="speed-control-spinner"></div>
                <div className="speed-control-progress-info">
                  <span>{processingProgress.current}/{processingProgress.total}</span>
                  {currentFile && (
                    <span className="speed-control-filename" title={currentFile}>
                      {currentFile}
                    </span>
                  )}
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
        {(!generationResults || generationResults.length === 0) ? (
          loadedFromCache ? (
            // Show loading indicator when loading from cache
            <div className="loading-from-cache-message">
              <LoadingIndicator
                theme="dark"
                showContainer={false}
                size={24}
                className="cache-loading-indicator"
              />
              {t('narration.loadingFromCache', 'Loading narrations from previous session...')}
            </div>
          ) : (
            // Show waiting message when no results and not loading from cache
            <div className="no-results-message">
              {t('narration.waitingForResults', 'Waiting for narration results...')}
            </div>
          )
        ) : (
          // Use virtualized list for better performance with large datasets
          <List
            ref={listRef}
            className="results-virtualized-list"
            height={700} // Increased height for the F5-TTS virtualized container to show more results
            width="100%"
            itemCount={generationResults ? generationResults.length : 0}
            itemSize={getRowHeight} // Dynamic row heights based on content
            overscanCount={18} // Increase overscan to reduce blanking during fast scrolls
            itemKey={(index, data) => (data.generationResults[index] && data.generationResults[index].subtitle_id) ?? index}
            itemData={{
              generationResults: generationResults || [],
              onRetry,
              retryingSubtitleId,
              currentAudio,
              isPlaying,
              playAudio,
              getAudioUrl,
              downloadAudio,
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
