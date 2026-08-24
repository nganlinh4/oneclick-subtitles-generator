import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  isMissingAudioFailure,
  loadNativeWaveform,
} from './audioProcessing';
import { prepareNativeWaveform } from './waveformLOD';
import {
  resolveActiveNativeMedia,
  refreshActiveNativeMedia,
} from '../../platform/activeNativeMedia';
import { isDesktopRuntime } from '../../platform/desktopRuntime';
import {
  renderWaveform as renderWaveformImpl,
  updateVisualization as updateVisualizationImpl,
} from './waveformRendering';

const DEBUG_WAVEFORM = typeof window !== 'undefined'
  && localStorage.getItem('debug_logs') === 'true';
const dbgWave = (...args) => { if (DEBUG_WAVEFORM) console.log(...args); };

const MAX_CACHED_WAVEFORMS = 4;
const waveformCache = new Map();

const cachedWaveform = (assetId) => {
  const waveform = waveformCache.get(assetId) ?? null;
  if (waveform !== null) {
    waveformCache.delete(assetId);
    waveformCache.set(assetId, waveform);
  }
  return waveform;
};

const cacheWaveform = (assetId, waveform) => {
  waveformCache.delete(assetId);
  waveformCache.set(assetId, waveform);
  while (waveformCache.size > MAX_CACHED_WAVEFORMS) {
    waveformCache.delete(waveformCache.keys().next().value);
  }
};

const abortableDelay = (milliseconds, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) {
    const error = new Error('The native waveform request was cancelled');
    error.name = 'AbortError';
    reject(error);
    return;
  }
  const handleAbort = () => {
    clearTimeout(timer);
    const error = new Error('The native waveform request was cancelled');
    error.name = 'AbortError';
    reject(error);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', handleAbort);
    resolve();
  }, milliseconds);
  signal.addEventListener('abort', handleAbort, { once: true });
});

const resolveWaveformCapability = async (candidate, signal) => {
  const retryDelays = [0, 100, 250, 500];
  let lastError;
  for (const delay of retryDelays) {
    if (delay > 0) await abortableDelay(delay, signal);
    try {
      return await resolveActiveNativeMedia({ candidate });
    } catch (error) {
      lastError = error;
      if (error?.name !== 'ActiveNativeMediaError') throw error;
    }
  }
  throw lastError;
};

/**
 * The editor waveform is a native derived view. The WebView never fetches,
 * decodes, chunks, or downsamples media; it only paints Rust's bounded pyramid.
 */
const VolumeVisualizer = ({ audioSource, duration, visibleTimeRange, height = 26 }) => {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const lastRenderParamsRef = useRef(null);
  const animationFrameRef = useRef(null);
  const requestEpochRef = useRef(0);
  const [waveform, setWaveform] = useState(null);
  const [status, setStatus] = useState('idle');
  const [processingProgress, setProcessingProgress] = useState(0);

  useEffect(() => {
    const requestEpoch = requestEpochRef.current + 1;
    requestEpochRef.current = requestEpoch;
    const controller = new AbortController();
    const isCurrent = () => (
      !controller.signal.aborted && requestEpochRef.current === requestEpoch
    );

    lastRenderParamsRef.current = null;
    setWaveform(null);
    setProcessingProgress(0);
    if (!audioSource || !(typeof duration === 'number' && Number.isFinite(duration) && duration > 0)) {
      setStatus('idle');
      return () => controller.abort();
    }
    setStatus('processing');

    const run = async () => {
      try {
        if (!isDesktopRuntime()) {
          throw new Error('Native waveform processing requires the desktop runtime');
        }
        const capability = await resolveWaveformCapability(audioSource, controller.signal);
        if (!isCurrent()) return;
        let nextWaveform = cachedWaveform(capability.assetId);
        if (nextWaveform === null) {
          const nativeWaveform = await loadNativeWaveform({
            assetId: capability.assetId,
            durationSeconds: duration,
            signal: controller.signal,
            onProgress: (progress) => {
              if (!isCurrent()) return;
              setProcessingProgress((current) => Math.max(current, progress));
            },
            revalidate: () => refreshActiveNativeMedia(capability),
          });
          if (!isCurrent()) return;
          nextWaveform = prepareNativeWaveform(nativeWaveform);
          cacheWaveform(capability.assetId, nextWaveform);
        }
        if (!isCurrent()) return;
        setProcessingProgress(1);
        setWaveform(nextWaveform);
        setStatus('ready');
      } catch (error) {
        if (!isCurrent() || error?.name === 'AbortError') return;
        if (error?.name === 'ActiveNativeMediaError') {
          dbgWave('[WAVEFORM] Active media changed before waveform publication');
        } else if (isMissingAudioFailure(error)) {
          dbgWave('[WAVEFORM] Selected media has no usable audio stream');
        } else {
          console.error('[WAVEFORM] Native waveform unavailable:', error);
        }
        // Waveforms are an optional derived view. Failure must never block or
        // cover the subtitle timeline with a permanent status surface.
        setStatus('unavailable');
      }
    };

    void run();
    return () => {
      requestEpochRef.current += 1;
      controller.abort();
    };
  }, [audioSource, duration]);

  const renderWaveform = useCallback((canvas, containerWidth) => {
    renderWaveformImpl(canvas, containerWidth, {
      waveform, visibleTimeRange, seekableEnd: duration, height, dbgWave,
    });
  }, [waveform, visibleTimeRange, duration, height]);

  const updateVisualization = useCallback(() => {
    updateVisualizationImpl({
      canvasRef, containerRef, waveform, visibleTimeRange, height,
      lastRenderParamsRef, renderWaveform,
    });
  }, [waveform, visibleTimeRange, height, renderWaveform]);

  useEffect(() => {
    if (!waveform || !containerRef.current) return undefined;
    updateVisualization();
    const resizeObserver = new ResizeObserver(() => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = requestAnimationFrame(updateVisualization);
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [waveform, updateVisualization]);

  useEffect(() => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = requestAnimationFrame(updateVisualization);
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };
  }, [visibleTimeRange, updateVisualization]);

  if (status === 'idle' || status === 'unavailable') return null;

  const loadingText = duration > 300
    ? t('waveform.processing_long', 'Processing audio ({{progress}}%)...', {
      progress: Math.round(processingProgress * 100),
    })
    : t('waveform.processing', 'Processing audio waveform...');

  return (
    <div
      ref={containerRef}
      className="volume-visualizer"
      data-osg-waveform-state={status}
      style={{
        height: `${height}px`,
        position: 'relative',
        overflow: 'hidden',
        zIndex: 5,
      }}
    >
      <canvas
        key={audioSource}
        ref={canvasRef}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />
      {status === 'processing' && (
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
            pointerEvents: 'none',
          }}
        >
          <span className="material-symbols-rounded" style={{ fontSize: '16px', animation: 'spin 1s linear infinite' }}>refresh</span>
          {loadingText}
        </div>
      )}
    </div>
  );
};

export default VolumeVisualizer;
