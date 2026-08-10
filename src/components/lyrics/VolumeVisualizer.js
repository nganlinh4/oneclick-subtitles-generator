import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  processEntireAudio,
  processBlobInChunks,
  processAudioInSegments,
  processNativeWaveform,
} from './audioProcessing';
import { resolveActiveNativeMediaAssetId } from '../../platform/activeNativeMedia';
import {
  renderWaveform as renderWaveformImpl,
  updateVisualization as updateVisualizationImpl,
} from './waveformRendering';

// Debug gate for waveform logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_WAVEFORM = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbgWave = (...args) => { if (DEBUG_WAVEFORM) console.log(...args); };

// Global cache for audio data to avoid reprocessing the same audio
const audioDataCache = new Map();

/**
 * Professional-grade volume visualizer with high-DPI support and efficient zoom rendering
 * @param {string} audioSource - URL of the audio/video source
 * @param {number} duration - Total duration of the audio/video
 * @param {Object} visibleTimeRange - Visible time range object
 * @param {number} height - Height of the visualizer
 * @returns {React.Component} - Volume visualizer component
 */
const VolumeVisualizer = ({ audioSource, duration, visibleTimeRange, height = 26 }) => {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [waveformLOD, setWaveformLOD] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [isProcessed, setIsProcessed] = useState(false);
  const [hasAudio, setHasAudio] = useState(true);
  const [audioError, setAudioError] = useState(null);
  const audioContextRef = useRef(null);
  const lastRenderParamsRef = useRef(null);
  const animationFrameRef = useRef(null);
  const abortControllerRef = useRef(null);
  const processingSourceRef = useRef(null);
  const debounceTimerRef = useRef(null);

  // Determine if this is long audio for display purposes
  const isLongAudio = duration > 300; // Process in chunks if longer than 5 minutes

  // Process audio data once when audioSource changes
  useEffect(() => {
    // Clear any existing debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    // Skip if no source
    if (!audioSource) {
      return;
    }

    // Debounce rapid source changes (wait 100ms for source to stabilize)
    const currentSource = audioSource;
    const currentDuration = duration;

    debounceTimerRef.current = setTimeout(() => {
      dbgWave('[WAVEFORM] Processing after debounce:', {
        audioSource: currentSource?.substring(0, 100),
        duration: currentDuration
      });

      // Skip if we don't have a valid duration yet
      if (!currentDuration || currentDuration <= 0) {
        dbgWave('[WAVEFORM] Invalid duration, skipping processing for now');
        return;
      }

      // If we already have waveform data loaded, skip processing
      if (waveformLOD && isProcessed && processingSourceRef.current === currentSource) {
        dbgWave('[WAVEFORM] Already have waveform data for this source, skipping');
        return;
      }

      // Skip if already processing this exact source
      if (isProcessing && processingSourceRef.current === currentSource) {
        dbgWave('[WAVEFORM] Already processing this exact source, skipping');
        return;
      }

      // Skip if we're processing a different source - abort it first
      if (isProcessing && processingSourceRef.current !== currentSource) {
        dbgWave('[WAVEFORM] Processing different source, aborting previous');
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setIsProcessing(false);
        processingSourceRef.current = null;
      }

      // Abort any existing processing when the source changes
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
      }
      const localAbortController = new AbortController();
      abortControllerRef.current = localAbortController;
      processingSourceRef.current = currentSource;

      // Reset states for the new audio source
      setWaveformLOD(null);
      setIsProcessing(true);
      setIsProcessed(false);
      setHasAudio(true);
      setAudioError(null);
      setProcessingProgress(0);

      // Skip YouTube URLs
      if (currentSource.includes('youtube.com') || currentSource.includes('youtu.be')) {
        setHasAudio(false);
        setAudioError('YouTube videos cannot be processed due to CORS restrictions');
        setIsProcessing(false);
        processingSourceRef.current = null;
        return;
      }

      // Check cache first
      const cachedData = audioDataCache.get(currentSource);
      if (cachedData) {
        if (cachedData === 'NO_AUDIO') {
          setHasAudio(false);
          setAudioError('No audio track found in this video');
        } else {
          setWaveformLOD(cachedData);
        }
        setIsProcessing(false);
        setIsProcessed(true);
        processingSourceRef.current = null;
        return;
      }

      // Shared context for the extracted processing pipelines. Everything they
      // need (setters, refs, source/duration, cache, logger) is passed in so
      // they never close over component state directly.
      const processingCtx = {
        currentSource,
        currentDuration,
        duration,
        audioContextRef,
        processingSourceRef,
        audioDataCache,
        dbgWave,
        setWaveformLOD,
        setIsProcessing,
        setIsProcessed,
        setHasAudio,
        setAudioError,
        setProcessingProgress,
      };

      const processAudio = async () => {
        const nativeAssetId = resolveActiveNativeMediaAssetId(currentSource);
        if (nativeAssetId !== null) {
            await processNativeWaveform(
              processingCtx,
              nativeAssetId,
              localAbortController.signal
            );
            return;
        }

        // Check if this is a blob URL - blob URLs don't support range requests
        const isBlobUrl = currentSource.startsWith('blob:');

        // For long videos (regardless of source), we need to be smarter
        // If it's extremely long (over 1 hour) and a blob, we should still use segments to avoid memory issues
        const isExtremelyLong = currentDuration > 3600; // 1 hour
        const isLongAudioForCurrent = currentDuration > 300; // 5 minutes

        if (!isLongAudioForCurrent) {
            // Short audio - process entirely
            await processEntireAudio(processingCtx, localAbortController.signal);
        } else if (isExtremelyLong && isBlobUrl) {
            // Very long blob - we need to chunk it to avoid memory issues
            await processBlobInChunks(processingCtx, localAbortController.signal);
        } else if (!isBlobUrl) {
            // Long non-blob audio - use range requests for efficiency
            await processAudioInSegments(processingCtx, localAbortController.signal);
        } else {
            // Regular long blob (under 1 hour) - process entirely
            await processEntireAudio(processingCtx, localAbortController.signal);
        }
      };

      processAudio();

      // Cleanup function
      return () => {
        if (localAbortController) {
          try {
            dbgWave('[WAVEFORM] Cleanup: aborting fetch');
            localAbortController.abort();
          } catch {
            // Abort is best-effort during effect cleanup.
          }
        }
        if (processingSourceRef.current === currentSource) {
          processingSourceRef.current = null;
        }
      };
    }, 100); // End of setTimeout

    // Cleanup debounce timer on unmount
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [audioSource, duration, isLongAudio, waveformLOD, isProcessed, isProcessing]);

  // Waveform rendering function - using the working approach from old code
  const renderWaveform = useCallback((canvas, containerWidth) => {
    renderWaveformImpl(canvas, containerWidth, { waveformLOD, visibleTimeRange, duration, height, dbgWave });
  }, [waveformLOD, visibleTimeRange, duration, height]);

  // Update visualization function (unchanged)
  const updateVisualization = useCallback(() => {
    updateVisualizationImpl({
      canvasRef, containerRef, waveformLOD, visibleTimeRange, height,
      lastRenderParamsRef, renderWaveform,
    });
  }, [waveformLOD, visibleTimeRange, height, renderWaveform]);

  // Main rendering and resize observer effects (unchanged)
  useEffect(() => {
    if (!waveformLOD || !containerRef.current) return;
    updateVisualization();
    const resizeObserver = new ResizeObserver(() => {
      if(animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(updateVisualization);
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [waveformLOD, updateVisualization]);

  useEffect(() => {
    if(animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = requestAnimationFrame(updateVisualization);
    return () => {
        if(animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [visibleTimeRange, updateVisualization]);

  // Don't render if processed and no audio exists
  if (!hasAudio && isProcessed) {
    return null;
  }

  const loadingText = isLongAudio
    ? t('waveform.processing_long', 'Processing audio ({{progress}}%)...', { progress: Math.round(processingProgress * 100) })
    : t('waveform.processing', 'Processing audio waveform...');

  return (
    <div
      ref={containerRef}
      className="volume-visualizer"
      style={{
        height: `${height}px`,
        position: 'relative',
        overflow: 'hidden',
        zIndex: 5
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'block'
        }}
      />
      {isProcessing && (
        <div
          className="volume-visualizer-loading"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '12px',
            color: 'var(--md-on-surface)',
            padding: '4px 8px',
            borderRadius: '4px',
            zIndex: 10,
            pointerEvents: 'none'
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '16px', animation: 'spin 1s linear infinite' }}>refresh</span>
          {loadingText}
        </div>
      )}
      {audioError && !isProcessing &&(
        <div
          className="volume-visualizer-no-audio"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            fontSize: '12px',
            color: 'var(--md-outline)',
            opacity: 0.7,
            zIndex: 2,
            pointerEvents: 'none'
          }}
        >
          {audioError}
        </div>
      )}
    </div>
  );
};

export default VolumeVisualizer;
