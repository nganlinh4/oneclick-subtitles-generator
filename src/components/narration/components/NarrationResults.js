import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import StandardSlider from '../../common/StandardSlider';
import LoadingIndicator from '../../common/LoadingIndicator';
import HelpIcon from '../../common/HelpIcon';
// Removed PlayPauseMorphType4 import - replaced with simple material symbols
import '../../../utils/functionalScrollbar';
import { VariableSizeList as List } from 'react-window';
import { SERVER_URL } from '../../../config';
import { deriveSubtitleId, idsEqual } from '../../../utils/subtitle/idUtils';
import { enhanceF5TTSNarrations } from '../../../utils/narrationEnhancer';
import { formatTime } from '../../../utils/timeFormatter';

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

  const isTransformed = result.transformations && result.transformations.transformed;

  // Generate tooltip content for transformations
  const getTransformationTooltip = () => {
    if (!isTransformed || !result.transformations) return null;

    const parts = [];
    if (result.transformations.punctuation_replaced && result.transformations.punctuation_replaced.length > 0) {
      parts.push(t('narration.transformations.punctuationReplaced', {
        punctuation: result.transformations.punctuation_replaced.join('')
      }));
    }

    const hasNumbers = result.transformations.numbers_converted && result.transformations.numbers_converted.length > 0;
    const hasDates = result.transformations.dates_converted && result.transformations.dates_converted.length > 0;

    if (hasNumbers && hasDates) {
      parts.push(t('narration.transformations.numbersAndDatesConverted'));
    } else if (hasNumbers) {
      parts.push(t('narration.transformations.numbersConverted'));
    } else if (hasDates) {
      parts.push(t('narration.transformations.datesConverted'));
    }

    return parts.join(', ');
  };

  const tooltipContent = getTransformationTooltip();

  const resultItem = (
    <div
      style={style}
      className={`result-item
        ${result.success ? '' : result.pending ? 'pending' : 'failed'}
        ${currentAudio && currentAudio.id === subtitle_id ? 'playing' : ''}
        ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}
        ${isTransformed ? 'transformed' : ''}`}
    >
      <div className="result-text hide-native-scrollbar">
        {/* Display 1-based row number for user-friendly sequential numbering */}
        <span className="result-id">{index + 1}.</span>
        {result.text}
        {isTransformed && tooltipContent && (
          <HelpIcon
            title={tooltipContent}
            size={12}
            className="transformation-help-icon"
            style={{ marginLeft: '8px', verticalAlign: 'middle' }}
          />
        )}
      </div>

      <div className="result-controls">
        {result.pending ? (
          <>
            {onRetry && (
              <button
                className={`pill-button secondary generate-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={() => onRetry(subtitle_id)}
                title={t('narration.generate', 'Generate this narration')}
                disabled={retryingSubtitleId === subtitle_id}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <LoadingIndicator
                    theme="dark"
                    showContainer={false}
                    size={14}
                    className="generate-loading-indicator"
                  />
                ) : (
                  <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>refresh</span>
                )}
              </button>
            )}
          </>
        ) : result.success ? (
          <>
            {/* Per-item trim range slider */}
            {result && (
              <div className="per-item-trim-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 8 }}>
                {(() => {
                  const getBackupName = (fn) => {
                    if (!fn) return null;
                    const lastSlash = fn.lastIndexOf('/');
                    const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
                    const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
                    return `${dir ? dir + '/' : ''}backup_${base}`;
                  };
                  const backupName = getBackupName(result.filename);
                  const backupDuration = (backupName && data.itemDurations && typeof data.itemDurations[backupName] === 'number')
                    ? data.itemDurations[backupName]
                    : null;
                  const currentDuration = (typeof result.filename === 'string' && data.itemDurations && typeof data.itemDurations[result.filename] === 'number')
                    ? data.itemDurations[result.filename]
                    : null;
                  const totalDuration = (typeof backupDuration === 'number' && backupDuration > 0)
                    ? backupDuration
                    : (typeof currentDuration === 'number' && currentDuration > 0)
                      ? currentDuration
                      : (typeof result.audioDuration === 'number' && result.audioDuration > 0)
                        ? result.audioDuration
                        : (typeof result.start === 'number' && typeof result.end === 'number' && result.end > result.start)
                          ? (result.end - result.start)
                          : 0;
                  const trim = data.itemTrims[subtitle_id] ?? [0, totalDuration];
                  const [trimStart, trimEnd] = trim;
                  return (
                    <>
                      <span style={{ minWidth: 35, maxWidth: 70, display: 'inline-block', textAlign: 'center', fontSize: '1em', fontWeight: 500 }}>
                        {formatTime(trimStart, 's_ms')}
                      </span>
                      <StandardSlider
                        range
                        value={[trimStart, trimEnd]}
                        min={0}
                        max={totalDuration}
                        step={0.01}
                        minGap={0.25}
                        onChange={([start, end]) => data.setItemTrim(subtitle_id, [start, end])}
                        onDragEnd={() => data.modifySingleAudioEditCombined(result)}
                        orientation="Horizontal"
                        size="XSmall"
                        width="compact"
                        showValueIndicator={false}
                        showStops={false}
                        className="per-item-trim-slider trim-slider"
                        style={{ width: 200 }}
                      />
                      <span style={{ minWidth: 35, maxWidth: 70, display: 'inline-block', textAlign: 'center', fontSize: '1em', fontWeight: 500 }}>
                        {formatTime(trimEnd, 's_ms')}
                      </span>
                    </>
                  );
                })()}
              </div>
            )}

            {/* Per-item speed slider */}
            {result.filename && (
              <SliderWithValue
                value={data.itemSpeeds[subtitle_id] ?? 1.0}
                onChange={(v) => data.setItemSpeed(subtitle_id, parseFloat(v))}
                onDragEnd={() => data.modifySingleAudioEditCombined(result)}
                min={0.5}
                max={2.0}
                step={0.01}
                defaultValue={1.0}
                orientation="Horizontal"
                size="XSmall"
                state={data.itemProcessing[subtitle_id]?.inProgress ? 'Disabled' : 'Enabled'}
                width="compact"
                className="standard-slider-container width-compact orientation-horizontal size-XSmall state-Enabled speed-control-slider"
                style={{ width: '75px', marginRight: 0, gap: 0 }}
                id={`item-speed-${subtitle_id}`}
                ariaLabel={t('narration.speed', 'Speed')}
                formatValue={(val) => `${Number(val).toFixed(2)}x`}
              />
            )}

            <button
              className="pill-button primary"
              onClick={() => playAudio(result)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>
                {currentAudio && currentAudio.id === subtitle_id && isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>
            <button
              className="pill-button secondary"
              onClick={() => downloadAudio(result)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>download</span>
            </button>
            {onRetry && (
              <button
                className={`pill-button secondary ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={() => onRetry(subtitle_id)}
                title={t('narration.retry', 'Retry generation')}
                disabled={retryingSubtitleId === subtitle_id || !!data.itemProcessing[subtitle_id]?.inProgress}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <LoadingIndicator
                    theme="dark"
                    showContainer={false}
                    size={14}
                    className="retry-loading-indicator"
                  />
                ) : (
                  <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>refresh</span>
                )}
              </button>
            )}
          </>
        ) : (
          <>
            {onRetry && (
              <button
                className={`pill-button secondary retry-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
                onClick={() => onRetry(subtitle_id)}
                title={t('narration.retry', 'Retry generation')}
                disabled={retryingSubtitleId === subtitle_id}
              >
                {retryingSubtitleId === subtitle_id ? (
                  <LoadingIndicator
                    theme="dark"
                    showContainer={false}
                    size={14}
                    className="retry-loading-indicator"
                  />
                ) : (
                  <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>refresh</span>
                )}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );

  return resultItem;
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
  onGenerateAllPending,
  subtitleSource,
  isGenerating,
  plannedSubtitles
}) => {
  const { t } = useTranslation();

  const listRef = useRef(null);
  const rowHeights = useRef({});

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

  // Speed control state

  // Real file durations from server for slider max
  const [itemDurations, setItemDurations] = useState({}); // { [filename]: seconds }

  const fetchDurationsBatch = async (filenames) => {
    if (!Array.isArray(filenames) || filenames.length === 0) return;
    try {
      const resp = await fetch(`${SERVER_URL}/api/narration/batch-get-audio-durations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filenames })
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data?.success && data.durations) {
        setItemDurations(prev => ({ ...prev, ...data.durations }));
      }
    } catch (e) {
      // ignore
    }
  };

  // Load durations for both main files and their trim backups
  useEffect(() => {
    const getBackupName = (fn) => {
      if (!fn) return null;
      const lastSlash = fn.lastIndexOf('/');
      const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
      const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
      return `${dir ? dir + '/' : ''}backup_${base}`;
    };

    const filenames = (displayedResults || [])
      .map(r => r && r.filename)
      .filter(Boolean);

    const backupFilenames = filenames.map(getBackupName).filter(Boolean);

    const allFilenames = [...new Set([...filenames, ...backupFilenames])];

    if (allFilenames.length > 0) {
      fetchDurationsBatch(allFilenames);
    }
  }, [displayedResults]);

  const [speedValue, setSpeedValue] = useState(1.0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [currentFile, setCurrentFile] = useState('');
  // Track processed count robustly during streaming and unique items seen
  const processedCountRef = useRef(0);
  const seenItemsRef = useRef(new Set());

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

  // Per-item speed state
  const [itemSpeeds, setItemSpeeds] = useState({}); // { [subtitle_id]: number }
  const [itemProcessing, setItemProcessing] = useState({}); // { [subtitle_id]: { inProgress: boolean } }

  // Per-item trim state: { [subtitle_id]: [startSec, endSec] }
  const [itemTrims, setItemTrims] = useState({});

  const setItemSpeed = (id, val) => {
    setItemSpeeds(prev => ({ ...prev, [id]: val }));
  };
  const setItemTrim = (id, range) => {
    setItemTrims(prev => ({ ...prev, [id]: range }));
  };

  // Modify speed for all successful items (existing global control)
  const modifyAudioSpeed = async () => {
    if (!generationResults || generationResults.length === 0) return;

    const successfulNarrations = generationResults.filter(r => r.success && r.filename);
    if (successfulNarrations.length === 0) return;

    // Adjust all individual sliders to match global speed (including 1x)
    {
      const newSpeeds = {};
      successfulNarrations.forEach(r => { newSpeeds[r.subtitle_id] = Number(speedValue); });
      setItemSpeeds(prev => ({ ...prev, ...newSpeeds }));
    }

    setIsProcessing(true);
    // Use only the actual files we will process for total
    setProcessingProgress({ current: 0, total: successfulNarrations.length });
    // Do not show current filename in UI (keep state but blank)
    setCurrentFile('');

    try {
      // Build items with normalized trim (if any) relative to backup duration
      const getBackupName = (fn) => {
        if (!fn) return null;
        const lastSlash = fn.lastIndexOf('/');
        const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
        const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
        return `${dir ? dir + '/' : ''}backup_${base}`;
      };

      const items = successfulNarrations.map(r => {
        const id = r.subtitle_id;
        const filename = r.filename;
        const backupName = getBackupName(filename);
        const total = (backupName && typeof itemDurations[backupName] === 'number')
          ? itemDurations[backupName]
          : (typeof itemDurations[filename] === 'number')
            ? itemDurations[filename]
            : undefined;
        const [start, end] = itemTrims[id] || [0, total || 0];
        let normalizedStart = 0, normalizedEnd = 1;
        if (typeof total === 'number' && total > 0) {
          const s = typeof start === 'number' ? start : 0;
          const e = typeof end === 'number' ? end : total;
          normalizedStart = s / total;
          normalizedEnd = e / total;
        }
        return { filename, normalizedStart, normalizedEnd, speedFactor: speedValue };
      });

      const apiUrl = `${SERVER_URL}/api/narration/batch-modify-audio-trim-speed-combined`;
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      });
      if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';


      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // finalize immediately
          setIsProcessing(false);
          setCurrentFile('');
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (!chunk.startsWith('data: ')) continue;
          try {
            const obj = JSON.parse(chunk.slice(6));
            if (obj.status === 'progress') {
              const total = obj.total ?? items.length;
              // Robust processed computation: prefer 'processed', else numeric 'current', else infer via unique keys
              let processedNum = 0;
              if (typeof obj.processed === 'number') {
                processedNum = obj.processed;
              } else if (typeof obj.current === 'number') {
                processedNum = obj.current;
              } else {
                if (obj.current) {
                  const key = String(obj.current);
                  if (!seenItemsRef.current.has(key)) {
                    seenItemsRef.current.add(key);
                    processedCountRef.current += 1;
                  }
                }
                processedNum = processedCountRef.current;
              }
              setProcessingProgress({ current: processedNum, total });
              // Do not update currentFile for UI; omit filename display under progress
            } else if (obj.status === 'completed') {
              setProcessingProgress({ current: obj.processed ?? items.length, total: obj.total ?? items.length });
              setCurrentFile('');
              if (typeof window.resetAlignedNarration === 'function') {
                window.resetAlignedNarration();
              }
              window.dispatchEvent(new CustomEvent('narration-speed-modified', { detail: { speed: speedValue, timestamp: Date.now() } }));
              setIsProcessing(false);
            }
          } catch (e) {
            // ignore malformed chunk
          }
        }
      }

      // Background duration refresh, non-blocking
      try {
        const filenames = successfulNarrations.map(r => r.filename).filter(Boolean);
        const backupFilenames = filenames.map(getBackupName).filter(Boolean);
        const allFilenames = [...new Set([...filenames, ...backupFilenames])];
        const resp = await fetch(`${SERVER_URL}/api/narration/batch-get-audio-durations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: allFilenames })
        });
        if (resp.ok) {
          const data = await resp.json();
          const durations = data?.durations || {};
          setItemDurations(prev => ({ ...prev, ...durations }));
        }
      } catch (e) {
        // ignore
      }
    } catch (error) {
      console.error('Error applying batch combined edit:', error);
      alert(t('narration.speedModificationError', `Error applying batch edit: ${error.message}`));
    }
  };


  // Combined edit (trim + speed) for a single item; called on slider drop
  const modifySingleAudioEditCombined = async (result) => {
    if (!result?.filename) return;
    const id = result.subtitle_id;
    const [start, end] = itemTrims[id] || [undefined, undefined];
    const speed = itemSpeeds[id];

    // Compute normalized range relative to backup duration
    const getBackupName = (fn) => {
      if (!fn) return null;
      const lastSlash = fn.lastIndexOf('/');
      const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
      const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
      return `${dir ? dir + '/' : ''}backup_${base}`;
    };
    const backupName = getBackupName(result.filename);
    const total = (backupName && typeof itemDurations[backupName] === 'number')
      ? itemDurations[backupName]
      : (typeof itemDurations[result.filename] === 'number')
        ? itemDurations[result.filename]
        : undefined;

    let normalizedStart;
    let normalizedEnd;

    if (typeof total === 'number' && total > 0) {
      const s = typeof start === 'number' ? start : 0;
      const e = typeof end === 'number' ? end : total;
      normalizedStart = s / total;
      normalizedEnd = e / total;
    } else {
      const isDefaultTrim = typeof start !== 'number' && typeof end !== 'number';
      if (isDefaultTrim) {
        normalizedStart = 0; normalizedEnd = 1;
      } else {
        alert(t('narration.durationNotReady', 'Audio duration not ready yet. Please wait a moment and try again.'));
        return;
      }
    }

    setItemProcessing(prev => ({ ...prev, [id]: { inProgress: true } }));
    try {
      const apiUrl = `${SERVER_URL}/api/narration/modify-audio-trim-speed-combined`;
      const body = { filename: result.filename, normalizedStart, normalizedEnd };
      if (typeof speed === 'number') {
        body.speedFactor = speed;
      }
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
      // Drain
      const reader = response.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      if (typeof window !== 'undefined') {
        if (typeof window.resetAlignedNarration === 'function') {
          window.resetAlignedNarration();
        }
        window.dispatchEvent(new CustomEvent('narration-edit-modified', { detail: { start, end, speed, id, timestamp: Date.now() } }));
      }
    } catch (e) {
      console.error('Error applying combined audio edit:', e);
      alert(t('narration.trimModificationError', `Error applying edit: ${e.message}`));
    } finally {
      setItemProcessing(prev => ({ ...prev, [id]: { inProgress: false } }));
    }
  };





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
