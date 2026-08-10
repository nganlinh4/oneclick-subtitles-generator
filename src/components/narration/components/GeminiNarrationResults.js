import { useState, useRef, useEffect } from 'react';
import { generateSubtitleHash } from '../../../utils/subtitle/subtitleHash';
import { getCurrentMediaId } from '../../../utils/mediaId';
import { useTranslation } from 'react-i18next';
import SliderWithValue from '../../common/SliderWithValue';
import LoadingIndicator from '../../common/LoadingIndicator';
import '../../../styles/narration/speedControlSlider.css';
import '../../../utils/functionalScrollbar';
import { VariableSizeList as List } from 'react-window';

// Import utility functions and config
import { deriveSubtitleId, idsEqual } from '../../../utils/subtitle/idUtils';

// Extracted siblings
import GeminiResultRow from './GeminiResultRow';
import { playAudio as playAudioImpl, downloadAudio as downloadAudioImpl } from '../utils/geminiAudioControls';
import useGeminiAudioSpeed from '../hooks/useGeminiAudioSpeed';
import { releaseNativeNarrationPlayback } from '../../../platform/nativeNarrationArtifacts';

// Constants for localStorage keys
const NARRATION_CACHE_KEY = 'gemini_narration_cache';

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

  useEffect(() => () => {
    const audio = audioRef.current;
    if (!audio) return;
    try { audio.pause(); } catch (_) { /* noop */ }
    if (audio.__nativeNarrationPlayback) {
      releaseNativeNarrationPlayback(audio.__nativeNarrationPlayback);
      audio.__nativeNarrationPlayback = null;
    }
    audioRef.current = null;
  }, []);

  // Speed control state (global)
  const [speedValue, setSpeedValue] = useState(1.0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });
  const [, setCurrentFile] = useState('');

  // Per-item speed state
  const [itemSpeeds, setItemSpeeds] = useState({}); // { [subtitle_id]: number }
  const [itemProcessing, setItemProcessing] = useState({}); // { [subtitle_id]: { inProgress: boolean } }
  const setItemSpeed = (id, val) => setItemSpeeds(prev => ({ ...prev, [id]: val }));

  // Per-item trim state: { [subtitle_id]: [startSec, endSec] }
  const [itemTrims, setItemTrims] = useState({});
  const setItemTrim = (id, range) => setItemTrims(prev => ({ ...prev, [id]: range }));

  // Real file durations from server for slider max
  const [itemDurations, setItemDurations] = useState({}); // { [filename]: seconds }

  // Audio speed/trim editing + duration fetching (extracted hook)
  const { modifyAudioSpeed, modifySingleAudioEditCombined, fetchDurationsBatch } = useGeminiAudioSpeed({
    generationResults,
    speedValue,
    itemSpeeds,
    itemTrims,
    itemDurations,
    setItemSpeeds,
    setItemDurations,
    setItemProcessing,
    setIsProcessing,
    setProcessingProgress,
    setCurrentFile,
    processedCountRef,
    seenItemsRef,
    t
  });

  // Audio playback/download (extracted utils) — thread component state in
  const playAudio = (result) => playAudioImpl(result, {
    audioRef,
    currentlyPlaying,
    isPlaying,
    setCurrentlyPlaying,
    setIsPlaying
  });
  const downloadAudio = (result) => downloadAudioImpl(result, t);

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

  // Stable key derived from filenames to avoid re-render loops
  // (displayedResults is a new array every render, so we derive a string key instead)
  const durationFetchKey = (displayedResults || [])
    .map(r => r && r.filename)
    .filter(Boolean)
    .join(',');

  // Load durations for both main files and their trim backups when the displayed list changes
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationFetchKey]);

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
          nativeArtifactId: result.nativeArtifactId,
          nativeFormat: result.nativeFormat,
          durationMicros: result.durationMicros,
          success: result.success,
          pending: result.pending,
          text: result.text,
          method: result.method,
          outputIndex: result.outputIndex,
          original_ids: result.original_ids,
          start: result.start,
          end: result.end,
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
      // The surrounding results section owns the loading presentation.
    }
  }, [loadedFromCache, generationResults]);

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
