import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import StandardSlider from '../../common/StandardSlider';
import LoadingIndicator from '../../common/LoadingIndicator';
import '../../../styles/narration/speedControlSlider.css';
import '../../../utils/functionalScrollbar';
import { VariableSizeList as List } from 'react-window';

// Import utility functions and config
import { getAudioUrl } from '../../../services/narrationService';
import { SERVER_URL } from '../../../config';
import { deriveSubtitleId, idsEqual } from '../../../utils/subtitle/idUtils';
import { formatTime } from '../../../utils/timeFormatter';
// Removed PlayPauseMorphType4 import - replaced with simple material symbols

// Constants for localStorage keys
const NARRATION_CACHE_KEY = 'gemini_narration_cache';
const CURRENT_VIDEO_ID_KEY = 'current_video_url';
const CURRENT_FILE_ID_KEY = 'current_file_cache_id';

/**
 * Component for displaying Gemini narration results with audio playback
 * @param {Object} props - Component props
 * @param {Array} props.generationResults - Array of narration results
 * @param {Function} props.onRetry - Function to retry generation for a specific subtitle
 * @param {number|null} props.retryingSubtitleId - ID of the subtitle currently being retried
 * @param {Function} props.onRetryFailed - Function to retry all failed narrations
 * @param {boolean} props.hasGenerationError - Whether there was an error during generation
 * @param {string} props.subtitleSource - Selected subtitle source ('original' or 'translated')
 * @returns {JSX.Element} - Rendered component
 */
// Virtualized row renderer for Gemini narration results
const GeminiResultRow = ({ index, style, data }) => {
  const {
    generationResults,
    onRetry,
    retryingSubtitleId,
    currentlyPlaying,
    isPlaying,
    playAudio,
    downloadAudio,
    t
  } = data;

  const item = generationResults[index];
  const subtitle_id = item.subtitle_id;
  const text = item.text;

  return (
    <div
      style={style}
      className={`result-item
        ${item.success ? 'success' : 'failed'}
        ${item.pending ? 'pending' : ''}
        ${currentlyPlaying === subtitle_id ? 'playing' : ''}
        ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
    >
      <div className="result-text hide-native-scrollbar">
        {/* Display 1-based row number for user-friendly sequential numbering */}
        <span className="result-id">{index + 1}.</span>
        {text}
      </div>

      <div className="result-controls">
        {item.success && (item.audioData || item.filename) ? (
          // Successful generation with audio data or filename
          <>
            {/* Per-item trim range slider */}
            {item && (
              <div className="per-item-trim-controls" style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 8 }}>
                {(() => {
                  const getBackupName = (fn) => {
                    if (!fn) return null;
                    const lastSlash = fn.lastIndexOf('/');
                    const dir = lastSlash >= 0 ? fn.slice(0, lastSlash) : '';
                    const base = lastSlash >= 0 ? fn.slice(lastSlash + 1) : fn;
                    return `${dir ? dir + '/' : ''}backup_${base}`;
                  };

                  const backupName = getBackupName(item.filename);
                  const backupDuration = (backupName && data.itemDurations && typeof data.itemDurations[backupName] === 'number')
                    ? data.itemDurations[backupName]
                    : null;
                  const currentDuration = (typeof item.filename === 'string' && data.itemDurations && typeof data.itemDurations[item.filename] === 'number')
                    ? data.itemDurations[item.filename]
                    : null;

                  const totalDuration = (typeof backupDuration === 'number' && backupDuration > 0)
                    ? backupDuration
                    : (typeof currentDuration === 'number' && currentDuration > 0)
                      ? currentDuration
                      : (typeof item.audioDuration === 'number' && item.audioDuration > 0)
                        ? item.audioDuration
                        : (typeof item.start === 'number' && typeof item.end === 'number' && item.end > item.start)
                          ? (item.end - item.start)
                          : 10;
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
                        onDragEnd={() => data.modifySingleAudioEditCombined(item)}
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

            {/* Per-item speed slider before Play/Pause */}
            {item.filename && (
              <SliderWithValue
                value={data.itemSpeeds[subtitle_id] ?? 1.0}
                onChange={(v) => data.setItemSpeed(subtitle_id, parseFloat(v))}
                onDragEnd={() => data.modifySingleAudioEditCombined(item)}
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
                id={`gemini-item-speed-${subtitle_id}`}
                ariaLabel={t('narration.speed', 'Speed')}
                formatValue={(val) => `${Number(val).toFixed(2)}x`}
              />
            )}

            <button
              className="pill-button primary"
              onClick={() => playAudio(item)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>
                {currentlyPlaying === subtitle_id && isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>
            <button
              className="pill-button secondary"
              onClick={() => downloadAudio(item)}
              disabled={!!data.itemProcessing[subtitle_id]?.inProgress}
            >
              <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>download</span>
            </button>
            <button
              className={`pill-button secondary ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
              onClick={() => onRetry(subtitle_id)}
              title={!data.subtitleSource
                ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
                : t('narration.retry', 'Retry generation')}
              disabled={retryingSubtitleId === subtitle_id || !data.subtitleSource || !!data.itemProcessing[subtitle_id]?.inProgress}
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
          </>
        ) : item.pending ? (
          // Pending generation - show generate button
          <>
            <button
              className={`pill-button secondary generate-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
              onClick={() => onRetry(subtitle_id)}
              title={!data.subtitleSource
                ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
                : t('narration.generate', 'Generate this narration')}
              disabled={retryingSubtitleId === subtitle_id || !data.subtitleSource}
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
          </>
        ) : (
          // Failed generation
          <>
            <button
              className={`pill-button secondary retry-button ${retryingSubtitleId === subtitle_id ? 'retrying' : ''}`}
              onClick={() => onRetry(subtitle_id)}
              title={!data.subtitleSource
                ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
                : t('narration.retry', 'Retry generation')}
              disabled={retryingSubtitleId === subtitle_id || !data.subtitleSource}
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
          </>
        )}
      </div>
    </div>
  );
};

/**
 * Helper function to generate a hash for subtitles to use as a cache key
 * @param {Array} subtitles - Array of subtitle objects
 * @returns {string} - Hash string
 */
const generateSubtitleHash = (subtitles) => {
  if (!subtitles || !subtitles.length) return '';

  // Create a string representation of the subtitles (just IDs and text)
  const subtitleString = subtitles.map(s => `${s.subtitle_id}:${s.text}`).join('|');

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
 * Helper function to get the current video/file identifier
 * @returns {string|null} - Current video/file ID or null if not found
 */
const getCurrentMediaId = () => {
  // Check for YouTube URL first
  const youtubeUrl = localStorage.getItem(CURRENT_VIDEO_ID_KEY);
  if (youtubeUrl) {
    // Extract video ID from URL
    const match = youtubeUrl.match(/(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/);
    return match ? match[1] : null;
  }

  // Check for file cache ID
  return localStorage.getItem(CURRENT_FILE_ID_KEY);
};

const GeminiNarrationResults = ({
  generationResults,
  onRetry,
  retryingSubtitleId,
  onRetryFailed,
  onGenerateAllPending,
  hasGenerationError = false,
  subtitleSource,
  plannedSubtitles
}) => {
  const { t } = useTranslation();
  const [currentlyPlaying, setCurrentlyPlaying] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef(null);
  const listRef = useRef(null);
  const rowHeights = useRef({});
  const [loadedFromCache, setLoadedFromCache] = useState(false);
  // Track processed count during streaming speed modify to drive progress UI
  const processedCountRef = useRef(0);
  // Track unique items seen in progress stream to derive current count when server doesn't send 'processed'
  const seenItemsRef = useRef(new Set());
  // Track shown error toasts to avoid duplicates
  const [shownErrorToasts, setShownErrorToasts] = useState(new Set());

  // Speed control state (global)
  const [speedValue, setSpeedValue] = useState(1.0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [currentFile, setCurrentFile] = useState('');

  // Per-item speed state
  const [itemSpeeds, setItemSpeeds] = useState({}); // { [subtitle_id]: number }
  const [itemProcessing, setItemProcessing] = useState({}); // { [subtitle_id]: { inProgress: boolean } }
  const setItemSpeed = (id, val) => setItemSpeeds(prev => ({ ...prev, [id]: val }));

  // Per-item trim state: { [subtitle_id]: [startSec, endSec] }
  const [itemTrims, setItemTrims] = useState({});
  const setItemTrim = (id, range) => setItemTrims(prev => ({ ...prev, [id]: range }));

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

  // Check if there are any failed narrations
  const hasFailedNarrations = generationResults && generationResults.some(result => !result.success);

  // Check if there are any pending narrations
  const hasPendingNarrations = generationResults && generationResults.some(result => !result.success && result.pending);

  // Derive a displayed list that immediately shows the full "true" list during generation (like other methods)
  const displayedResults = (() => {
    // If caller provided an explicit plan prop (even empty), treat it as source of truth
    if (typeof plannedSubtitles !== 'undefined') {
      const plan = Array.isArray(plannedSubtitles) ? plannedSubtitles : [];
      if (plan.length === 0) return [];

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
      const results = plan.map((subtitle, index) => {
        // Use shared ID derivation for consistency across all methods
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

  // Load durations for both main files and their trim backups when the displayed list changes
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

  // Function to modify audio speed (global batch)
  const modifyAudioSpeed = async () => {
    if (!generationResults || generationResults.length === 0) {
      return;
    }

    try {
      // Get all successful narrations with filenames
      const successfulNarrations = generationResults.filter(
        result => result.success && result.filename
      );

      if (successfulNarrations.length === 0) {
        setIsProcessing(false);
        return;
      }

      // Adjust all individual sliders to match global speed (including 1x)
      {
        const newSpeeds = {};
        successfulNarrations.forEach(r => { newSpeeds[r.subtitle_id] = Number(speedValue); });
        setItemSpeeds(prev => ({ ...prev, ...newSpeeds }));
      }


      // Start processing
      setIsProcessing(true);
      // Only count files we will actually process
      setProcessingProgress({ current: 0, total: successfulNarrations.length });
      // Show first filename as "preparing" hint
      try {
        const firstName = successfulNarrations[0]?.filename || '';
        const base = firstName ? String(firstName).split('/').pop() : '';
        setCurrentFile(base);
      } catch (_) {
        setCurrentFile('');
      }

      console.log(`Modifying speed of ${successfulNarrations.length} narration files to ${speedValue}x`);

      // Use new batch combined endpoint to process all files at once
      const apiUrl = `${SERVER_URL}/api/narration/batch-modify-audio-trim-speed-combined`;

      // Build items with normalized trim relative to backup duration
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

      // Reset streaming progress trackers
      processedCountRef.current = 0;
      seenItemsRef.current = new Set();

      // Use fetch with streaming response to get real-time progress updates
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items })
      });

      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }

      // Set up a reader to read the streaming response (SSE parsing)
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Stream ended: immediately mark processing done
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
              // Determine processed count robustly
              let processedNum = 0;
              if (typeof obj.processed === 'number') {
                processedNum = obj.processed;
              } else if (typeof obj.current === 'number') {
                processedNum = obj.current;
              } else {
                // Infer from current filename if provided
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

              if (obj.current) {
                const filename = String(obj.current).split('/').pop();
                setCurrentFile(filename || '');
              }
            } else if (obj.status === 'completed') {
              setProcessingProgress({ current: obj.processed ?? items.length, total: obj.total ?? items.length });
              setCurrentFile('');
              if (typeof window.resetAlignedNarration === 'function') {
                window.resetAlignedNarration();
              }
              window.dispatchEvent(new CustomEvent('narration-speed-modified', {
                detail: { speed: speedValue, timestamp: Date.now() }
              }));
            }
          } catch (e) {
            // ignore malformed chunks
          }
        }
      }

      console.log(`Successfully applied combined trim+speed to ${items.length} files`);

      // Optionally refresh durations in background (non-blocking UI)
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
        // ignore duration refresh errors
      }
    } catch (error) {
      console.error('Error calling audio speed modification API:', error);
    } finally {
      // End processing
      setIsProcessing(false);
      setCurrentFile('');
    }
  };

  // Combined edit (trim + speed) for a single item; called on slider drop
  const modifySingleAudioEditCombined = async (result) => {
    if (!result?.filename) return;
    const id = result.subtitle_id;
    const [start, end] = itemTrims[id] || [undefined, undefined];
    const speed = itemSpeeds[id];

    // Compute normalized range relative to backup duration to keep UI mapping stable
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
        window.addToast(t('narration.durationNotReady', 'Audio duration not ready yet. Please wait a moment and try again.'), 'error');
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
      if (!response.ok) throw new Error(`Server responded with status: ${response.status} - ${await response.text()}`);
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
      window.addToast(t('narration.trimModificationError', `Error applying edit: ${e.message}`), 'error');
    } finally {
      setItemProcessing(prev => ({ ...prev, [id]: { inProgress: false } }));
    }
  };


  // Function to calculate row height based on explicit line breaks only (stable like LyricsDisplay)
  const getRowHeight = (index) => {
    // Return cached height if available
    if (rowHeights.current[index] !== undefined) {
      return rowHeights.current[index];
    }

    const item = displayedResults[index];
    if (!item) return 60; // Default height for a single-line item with controls

    // Only count explicit line breaks to avoid jitter from soft-wrap estimation
    const text = item.text || '';
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

    // Save narrations to cache when they change
    if (generationResults && generationResults.length > 0) {
      try {
        // Get current media ID
        const mediaId = getCurrentMediaId();
        if (!mediaId) return;

        // Generate a hash of the subtitles
        const subtitleHash = generateSubtitleHash(generationResults);

        // Create cache entry with only essential data
        const essentialNarrations = generationResults.map(result => ({
          subtitle_id: result.subtitle_id,
          filename: result.filename,
          success: result.success,
          text: result.text
        }));

        const cacheEntry = {
          mediaId,
          subtitleHash,
          timestamp: Date.now(),
          narrations: essentialNarrations
        };

        // Save to localStorage
        localStorage.setItem(NARRATION_CACHE_KEY, JSON.stringify(cacheEntry));

      } catch (error) {
        console.error('Error saving narrations to cache:', error);
      }
    }
  }, [generationResults]);

  // Load narrations from cache on component mount
  useEffect(() => {
    // Only try to load from cache if we don't have results yet
    if (generationResults && generationResults.length > 0) return;

    try {
      // Get current media ID
      const mediaId = getCurrentMediaId();
      if (!mediaId) return;

      // Get cache entry
      const cacheEntryJson = localStorage.getItem(NARRATION_CACHE_KEY);
      if (!cacheEntryJson) return;

      const cacheEntry = JSON.parse(cacheEntryJson);

      // Check if cache entry is for the current media
      if (cacheEntry.mediaId !== mediaId) return;

      // Check if we have narrations
      if (!cacheEntry.narrations || !cacheEntry.narrations.length) return;



      // Set loading state first
      setLoadedFromCache(true);

      // Use a small timeout to ensure the loading state is rendered
      setTimeout(() => {
        // Dispatch an event to notify other components about the loaded narrations
        const event = new CustomEvent('narrations-loaded-from-cache', {
          detail: {
            narrations: cacheEntry.narrations,
            timestamp: Date.now()
          }
        });
        window.dispatchEvent(event);
      }, 100);
    } catch (error) {
      console.error('Error loading narrations from cache:', error);
    }
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

  // Show toasts for failed narration items
  useEffect(() => {
    if (generationResults && generationResults.length > 0) {
      generationResults.forEach(result => {
        if (!result.success && !result.pending && !shownErrorToasts.has(result.subtitle_id)) {
          const errorMessage = result.error
            ? t('narration.generationFailedWithError', 'Generation failed: {{error}}', { error: result.error })
            : t('narration.generationFailed', 'Generation failed');
          window.addToast(errorMessage, 'error');
          setShownErrorToasts(prev => new Set([...prev, result.subtitle_id]));
        }
      });
    }
  }, [generationResults, shownErrorToasts, t]);

  // Show a loading message while waiting for narrations to load
  useEffect(() => {
    // If we have loaded from cache but don't have results yet, show a loading message
    if (loadedFromCache && (!generationResults || generationResults.length === 0)) {

    }
  }, [loadedFromCache, generationResults]);

  // Initialize audio element on component mount
  // Play directly from server URL from file system (no cache, no blob)
  const playAudio = async (result) => {
    if (!result?.filename) return;

    // Toggle off if the same item is already playing
    if (currentlyPlaying === result.subtitle_id && isPlaying) {
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch (_) {}
        try {
          if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
            URL.revokeObjectURL(audioRef.current.src);
          }
        } catch (_) {}
      }
      setIsPlaying(false);
      setCurrentlyPlaying(null);
      return;
    }

    // Stop any currently playing audio and revoke blob URL
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch (_) {}
      try {
        if (audioRef.current.src && audioRef.current.src.startsWith('blob:')) {
          URL.revokeObjectURL(audioRef.current.src);
        }
      } catch (_) {}
    }

    // Build cache-busting URL and fetch fresh file like other methods
    const baseUrl = getAudioUrl(result.filename);
    const cacheBustUrl = `${baseUrl}?t=${Date.now()}`;
    console.log(`[DEBUG] Playing audio via fresh fetch: ${cacheBustUrl}`);

    try {
      const resp = await fetch(cacheBustUrl, {
        headers: { 'Accept': 'audio/*' },
        credentials: 'include'
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);

      const audio = new Audio(blobUrl);
      audio.preload = 'none';
      audio.onerror = (e) => {
        console.error(`[DEBUG] Audio error for subtitle ${result.subtitle_id}:`, e);
        console.error(`[DEBUG] Audio src:`, audio.src);
      };
      audio.onended = () => {
        setIsPlaying(false);
        setCurrentlyPlaying(null);
        try {
          if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
        } catch (_) {}
      };

      setCurrentlyPlaying(result.subtitle_id);
      setIsPlaying(true);

      audio.play().catch((err) => {
        console.error('[DEBUG] Error playing audio:', err);
        setIsPlaying(false);
        setCurrentlyPlaying(null);
        try {
          if (audio.src && audio.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
        } catch (_) {}
      });

      audioRef.current = audio;
    } catch (e) {
      console.error('[DEBUG] Failed to fetch fresh audio, falling back to direct URL:', e);
      const audio = new Audio(cacheBustUrl);
      audio.preload = 'none';
      audio.onerror = (err) => {
        console.error('[DEBUG] Fallback audio error:', err);
      };
      audio.onended = () => {
        setIsPlaying(false);
        setCurrentlyPlaying(null);
      };
      setCurrentlyPlaying(result.subtitle_id);
      setIsPlaying(true);
      audio.play().catch(() => {
        setIsPlaying(false);
        setCurrentlyPlaying(null);
      });
      audioRef.current = audio;
    }
  };

  // Download audio as WAV file
  const downloadAudio = (result) => {
    if (result.filename) {
      try {
        console.log(`[DEBUG] Downloading audio with filename: ${result.filename}`);

        // Get the audio URL
        const audioUrl = getAudioUrl(result.filename);
        console.log(`[DEBUG] Download URL: ${audioUrl}`);

        // Add a cache-busting parameter to the URL
        const cacheBustUrl = `${audioUrl}?t=${Date.now()}`;
        console.log(`[DEBUG] Cache-busting download URL: ${cacheBustUrl}`);

        // Use fetch to get the file as a blob
        fetch(cacheBustUrl)
          .then(response => {
            console.log(`[DEBUG] Download fetch response status: ${response.status}`);
            if (!response.ok) {
              console.error(`[DEBUG] Download fetch failed: ${response.status} ${response.statusText}`);
              const errorMsg = `Server responded with ${response.status}: ${response.statusText}`;
              window.addToast(t('narration.downloadError', `Error downloading audio file: ${errorMsg}`), 'error');
              throw new Error(errorMsg);
            }
            return response.blob();
          })
          .then(blob => {
            console.log(`[DEBUG] Got blob for download, size: ${blob.size} bytes, type: ${blob.type}`);

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
            console.error('[DEBUG] Error downloading audio file:', error);
            window.addToast(t('narration.downloadError', `Error downloading audio file: ${error.message}`), 'error');
          });
      } catch (error) {
        console.error('[DEBUG] Error initiating download:', error);
        alert(t('narration.downloadError', `Error initiating download: ${error.message}`));
      }
    } else {
      console.error('[DEBUG] No filename available for download');
      window.addToast(t('narration.downloadError', 'No audio file available for download'), 'error');
    }
  };



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
            disabled={retryingSubtitleId !== null || !subtitleSource}
            title={!subtitleSource
              ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
              : t('narration.generateAllPendingTooltip', 'Generate all pending narrations')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: '14px' }}>play_arrow</span>
            {t('narration.generateAllPending', 'Generate All Pending')}
          </button>
        )}

        {/* Retry Failed Narrations button */}
        {hasFailedNarrations && onRetryFailed && (
          <button
            className="pill-button secondary retry-failed-button"
            onClick={onRetryFailed}
            disabled={retryingSubtitleId !== null || !subtitleSource}
            title={!subtitleSource
              ? t('narration.noSourceSelectedError', 'Please select a subtitle source (Original or Translated)')
              : t('narration.retryFailedTooltip', 'Retry all failed narrations')}
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
              id="gemini-speed-control"
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
        {(!displayedResults || displayedResults.length === 0) && !hasGenerationError ? (
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
            height={700} // Taller list to show more items and reduce churn while scrolling
            width="100%"
            itemCount={displayedResults.length}
            itemSize={getRowHeight} // Dynamic row heights based on content
            overscanCount={18} // Increase overscan to reduce blanking during fast scrolls
            itemKey={(index, data) => {
              const item = data.generationResults[index];
              const id = item && item.subtitle_id;
              // Unique and stable within a session
              return (id !== undefined && id !== null) ? `${String(id)}-${index}` : index;
            }}
            itemData={{
              generationResults: displayedResults,
              onRetry,
              retryingSubtitleId,
              currentlyPlaying,
              isPlaying,
              playAudio,
              downloadAudio,
              subtitleSource,
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
            {GeminiResultRow}
          </List>
        )}
      </div>



      {/* We're using a programmatically created audio element instead of this one */}
      {/* This is just a placeholder for the ref */}
    </div>
  );
};

export default GeminiNarrationResults;
