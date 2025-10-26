import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';


// Global cache for audio data to avoid reprocessing the same audio
const audioDataCache = new Map();

// High-DPI canvas utilities for crisp rendering at any zoom level
const getDevicePixelRatio = () => window.devicePixelRatio || 1;

const setupHighDPICanvas = (canvas, width, height) => {
  const dpr = getDevicePixelRatio();
  const rect = canvas.getBoundingClientRect();

  // Set actual canvas size in memory (scaled up for high-DPI)
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  // Scale the canvas back down using CSS
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  // Scale the drawing context so everything draws at the correct size
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  return ctx;
};

// Efficient waveform data structure for multi-resolution rendering
class WaveformLOD {
  constructor(audioData, maxLevels = 8) {
    this.levels = [];
    this.maxLevels = maxLevels;
    this.buildLODLevels(audioData);
  }

  buildLODLevels(audioData) {
    // Level 0: Original data
    this.levels[0] = audioData;

    // Build progressively lower resolution levels
    for (let level = 1; level < this.maxLevels; level++) {
      const prevLevel = this.levels[level - 1];
      const newLength = Math.max(Math.floor(prevLevel.length / 2), 1);
      const newLevel = new Float32Array(newLength);

      for (let i = 0; i < newLength; i++) {
        const start = i * 2;
        const end = Math.min(start + 2, prevLevel.length);

        // Use RMS for downsampling to preserve peaks
        let sum = 0;
        for (let j = start; j < end; j++) {
          sum += prevLevel[j] * prevLevel[j];
        }
        newLevel[i] = Math.sqrt(sum / (end - start));
      }

      this.levels[level] = newLevel;
    }
  }

  // Get the appropriate LOD level based on zoom and available pixels
  getLODLevel(samplesPerPixel) {
    // Choose LOD level based on how many samples we're trying to fit per pixel
    let level = 0;
    while (level < this.maxLevels - 1 && samplesPerPixel > Math.pow(2, level + 1)) {
      level++;
    }
    return this.levels[level];
  }
}

// Decode with timeout to avoid hanging on problematic sources
function decodeWithTimeout(audioContext, arrayBuffer, timeoutMs = 12000) {
  return Promise.race([
    audioContext.decodeAudioData(arrayBuffer),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Audio decode timed out')), timeoutMs))
  ]);
}

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
  const [isProcessed, setIsProcessed] = useState(false);
  const [hasAudio, setHasAudio] = useState(true);
  const [audioError, setAudioError] = useState(null);
  const [hasDrawn, setHasDrawn] = useState(false);
  const audioContextRef = useRef(null);
  const lastRenderParamsRef = useRef(null);
  const animationFrameRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const abortControllerRef = useRef(null);
  const processingSourceRef = useRef(null);
  const debounceTimerRef = useRef(null);

  // Process audio data once when the component mounts or audioSource changes
  useEffect(() => {
    // Clear any existing debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    
    // Skip if no source
    if (!audioSource) {
      console.log('[WAVEFORM] No audio source provided');
      return;
    }
    
    // Debounce rapid source changes (wait 100ms for source to stabilize)
    const currentSource = audioSource;
    const currentDuration = duration;
    
    debounceTimerRef.current = setTimeout(() => {
      console.log('[WAVEFORM] Processing after debounce:', {
        audioSource: currentSource?.substring(0, 100),
        isProcessed,
        isProcessing,
        hasAudio,
        duration: currentDuration
      });
      
      // If we already have waveform data loaded, skip processing
      if (waveformLOD && isProcessed) {
        // Check if it's for the same video (by ID)
        const currentVideoId = currentSource.match(/\/([a-zA-Z0-9_-]+)\.mp4/)?.[1];
        if (currentVideoId) {
          const cachedData = audioDataCache.get(`video_${currentVideoId}`);
          if (cachedData && cachedData === waveformLOD) {
            console.log('[WAVEFORM] Already have waveform data for this video, skipping');
            return;
          }
        }
      }
      
      // Skip if already processing this exact source
      if (isProcessing && processingSourceRef.current === currentSource) {
        console.log('[WAVEFORM] Already processing this exact source, skipping');
        return;
      }
      
      // Skip if we're processing a different source - abort it first
      if (isProcessing && processingSourceRef.current !== currentSource) {
        console.log('[WAVEFORM] Processing different source, aborting previous');
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        setIsProcessing(false);
        processingSourceRef.current = null;
      }
    
    // Check if this is the same source (handle blob to server URL transition)
    const isSameVideo = () => {
      // Extract video ID from URLs
      const getVideoId = (url) => {
        const match = url.match(/\/([a-zA-Z0-9_-]+)\.mp4/);
        return match ? match[1] : null;
      };
      
      const videoId = getVideoId(currentSource);
      if (videoId) {
        // First, check if we have cached data specifically for this video ID
        const videoCache = audioDataCache.get(`video_${videoId}`);
        if (videoCache && videoCache !== 'NO_AUDIO') {
          console.log('[WAVEFORM] Found cached data for video ID:', videoId);
          setWaveformLOD(videoCache);
          setIsProcessed(true);
          return true;
        }
        
        // Also check if any other URL has the same video ID
        for (const [cachedUrl, cachedData] of audioDataCache.entries()) {
          if (cachedUrl.startsWith('video_')) continue; // Skip video ID entries
          const cachedVideoId = getVideoId(cachedUrl);
          if (cachedVideoId === videoId && cachedData !== 'NO_AUDIO') {
            console.log('[WAVEFORM] Found cached data for same video ID from different URL:', videoId);
            setWaveformLOD(cachedData);
            setIsProcessed(true);
            return true;
          }
        }
      }
      return false;
    };
    
    // Check if it's the same video with different URL
    if (isSameVideo()) {
      return;
    }
    
      // Skip if already processed for this exact URL
      if (isProcessed && audioDataCache.has(currentSource)) {
        console.log('[WAVEFORM] Already processed this exact URL');
        return;
      }

      let isActive = true;
      let localAbortController = new AbortController();
      
      // Abort any existing request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      abortControllerRef.current = localAbortController;
      processingSourceRef.current = currentSource;

      // Reset states when audioSource changes
      setHasAudio(true);
      setAudioError(null);
      setHasDrawn(false);

      // Skip YouTube URLs as they can't be directly processed due to CORS
      if (currentSource.includes('youtube.com') || currentSource.includes('youtu.be')) {
        setHasAudio(false);
        setAudioError('YouTube videos cannot be processed due to CORS restrictions');
        return;
      }

      // Check if we already have this audio data in cache
      if (audioDataCache.has(currentSource)) {
        const cachedData = audioDataCache.get(currentSource);
        if (cachedData === 'NO_AUDIO') {
          setHasAudio(false);
          setAudioError('No audio track found in this video');
          setIsProcessed(true);
          return;
        }
        setWaveformLOD(cachedData);
        setIsProcessed(true);
        return;
      }

      // For long videos, use a more efficient approach with downsampling
      const isLongVideo = currentDuration > 1800; // 30 minutes

    const processAudio = async () => {
        console.log('[WAVEFORM] Starting audio processing:', {
          source: currentSource.substring(0, 100),
          duration: currentDuration,
          isLongVideo,
          isBlobUrl: currentSource.startsWith('blob:'),
          isLocalFile: currentSource.startsWith('/videos/')
        });
      
      try {
        setIsProcessing(true);

        // Create audio context with proper fallback
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContext();
        }

        // Use local abort controller instead of ref to avoid conflicts
        // abortControllerRef.current = localAbortController;

        // Fetch the audio data with abort support
        console.log('[WAVEFORM] Fetching audio data...');
        let response;
        const isBlob = currentSource.startsWith('blob:');
        try {
          if (isBlob && window.__videoBlobMap && window.__videoBlobMap[currentSource]) {
            // Directly use stored blob for faster access
            console.log('[WAVEFORM] Using cached blob');
            const blob = window.__videoBlobMap[currentSource];
            response = new Response(blob);
          } else {
            console.log('[WAVEFORM] Fetching from URL:', {
              isBlob,
              mode: isBlob ? 'no-cors' : 'cors'
            });
            response = await fetch(currentSource, { signal: localAbortController.signal, cache: 'no-cache', mode: isBlob ? 'no-cors' : 'cors' });
          }
        } catch (e) {
          console.log('[WAVEFORM] First fetch failed, retrying:', e.message);
          // Retry once without mode override
          response = await fetch(currentSource, { signal: localAbortController.signal, cache: 'no-cache' });
        }
        console.log('[WAVEFORM] Fetch complete, converting to arrayBuffer...');
        const arrayBuffer = await response.arrayBuffer();
        console.log('[WAVEFORM] ArrayBuffer size:', arrayBuffer.byteLength);

        // Decode the audio data with timeout to avoid hanging
        console.log('[WAVEFORM] Decoding audio data with timeout:', isLongVideo ? 15000 : 10000, 'ms');
        const startDecodeTime = Date.now();
        const audioBuffer = await decodeWithTimeout(audioContextRef.current, arrayBuffer, isLongVideo ? 15000 : 10000);
        console.log('[WAVEFORM] Audio decoded in', Date.now() - startDecodeTime, 'ms');

        // Check if the audio buffer has any channels (i.e., if there's actually audio)
        if (!audioBuffer || audioBuffer.numberOfChannels === 0) {
          throw new Error('No audio channels found in the media file');
        }

        // Get the audio channel data (mono - just use the first channel)
        const channelData = audioBuffer.getChannelData(0);

        // Calculate the number of samples to analyze
        // For long videos, use fewer samples to improve performance
        const sampleSize = isLongVideo ? 500 : 1000;
        const samplesPerSegment = Math.floor(channelData.length / sampleSize);

        // Calculate volume levels using a more efficient approach
        const volumeData = new Array(sampleSize);

        // For long videos, use a more efficient processing approach with Web Workers if available
        if (isLongVideo && window.Worker) {
          // Process in chunks to avoid blocking the main thread
          const chunkSize = 100; // Process 100 samples at a time

          for (let chunk = 0; chunk < sampleSize; chunk += chunkSize) {
            const endChunk = Math.min(chunk + chunkSize, sampleSize);

            // Process this chunk
            for (let i = chunk; i < endChunk; i++) {
              const startSample = i * samplesPerSegment;
              const endSample = Math.min(startSample + samplesPerSegment, channelData.length);

              // Use a more efficient RMS calculation for long videos
              // Sample every 10th value instead of every value
              let sum = 0;
              let count = 0;
              for (let j = startSample; j < endSample; j += 10) {
                sum += channelData[j] * channelData[j];
                count++;
              }
              volumeData[i] = Math.sqrt(sum / count);
            }

            // Yield to the main thread to prevent blocking
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        } else {
          // Standard processing for shorter videos, but chunked to avoid blocking UI
          const chunkSize = 80; // process 80 segments then yield
          for (let chunkStart = 0; chunkStart < sampleSize; chunkStart += chunkSize) {
            const chunkEnd = Math.min(chunkStart + chunkSize, sampleSize);
            for (let i = chunkStart; i < chunkEnd; i++) {
              const startSample = i * samplesPerSegment;
              const endSample = Math.min(startSample + samplesPerSegment, channelData.length);

              // Calculate RMS (root mean square) for this segment
              let sum = 0;
              for (let j = startSample; j < endSample; j++) {
                sum += channelData[j] * channelData[j];
              }
              volumeData[i] = Math.sqrt(sum / (endSample - startSample));
            }
            // Yield to main thread to keep timeline animations smooth
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        // Find the maximum volume value
        const maxVolume = Math.max(...volumeData);

        // Normalize the volume data to ensure the highest point will touch the ceiling
        if (maxVolume > 0) {
          // Apply a minimum scale factor to ensure even quiet audio is visible
          const minScaleFactor = 0.15;

          // Scale all values
          for (let i = 0; i < volumeData.length; i++) {
            // Normalize to 0-1 range
            volumeData[i] = volumeData[i] / maxVolume;

            // Apply a non-linear scaling to emphasize differences
            volumeData[i] = Math.pow(volumeData[i], 0.7);

            // Ensure a minimum height for better visualization
            volumeData[i] = Math.max(volumeData[i], minScaleFactor);
          }
        }

        // Create LOD structure for efficient multi-resolution rendering
        const waveformLOD = new WaveformLOD(volumeData);

        // Store the processed audio data only if component is still active and not aborted
        if (isActive && !localAbortController.signal.aborted) {
          console.log('[WAVEFORM] Processing complete, storing data');
          
          // Store in cache for this URL
          audioDataCache.set(currentSource, waveformLOD);
          
          // Also store by video ID if it's a server URL to share between blob and server URLs
          const videoIdMatch = currentSource.match(/\/([a-zA-Z0-9_-]+)\.mp4/);
          if (videoIdMatch) {
            const videoId = videoIdMatch[1];
            audioDataCache.set(`video_${videoId}`, waveformLOD);
            console.log('[WAVEFORM] Also cached for video ID:', videoId);
          }
          
          setWaveformLOD(waveformLOD);
          setIsProcessed(true);
          console.log('[WAVEFORM] ✅ Waveform data ready');
        } else {
          console.log('[WAVEFORM] Component unmounted or aborted, discarding data');
        }
      } catch (error) {
        // Swallow expected AbortError when unmounting or toggling off
        if (error && (error.name === 'AbortError' || error.message?.includes('aborted'))) {
          console.log('[WAVEFORM] Processing aborted (expected)');
          return;
        }

        console.error('[WAVEFORM] ❌ Error processing audio:', {
          error: error.message,
          name: error.name,
          stack: error.stack?.substring(0, 500)
        });

        // Check if this is an audio decoding error (no audio track)
        if (error.name === 'EncodingError' ||
            error.message.includes('Unable to decode audio data') ||
            error.message.includes('No audio channels found') ||
            error.message.includes('could not be decoded')) {
          setHasAudio(false);
          setAudioError('No audio track found in this video');
          // Cache the fact that this source has no audio
          audioDataCache.set(currentSource, 'NO_AUDIO');
        } else {
          setAudioError(`Audio processing failed: ${error.message}`);
        }
        if (isActive) {
          setIsProcessed(true);
        }
      } finally {
        if (isActive) {
          setIsProcessing(false);
          // Clear the processing source ref when done
          if (processingSourceRef.current === currentSource) {
            processingSourceRef.current = null;
          }
        }
      }
    };

    processAudio();

      // Cleanup function
      return () => {
        isActive = false;
        // Abort any in-flight fetch/processing
        if (localAbortController) {
          try { 
            console.log('[WAVEFORM] Cleanup: aborting fetch');
            localAbortController.abort(); 
          } catch {}
        }
        // Clear the ref if it's our controller
        if (abortControllerRef.current === localAbortController) {
          abortControllerRef.current = null;
          processingSourceRef.current = null;
        }
        // Don't close audio context here - keep it for reuse
      };
    }, 100); // End of setTimeout
    
    // Cleanup debounce timer on unmount
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [audioSource, duration]); // Remove isProcessed and isProcessing from deps to prevent loops

  // Professional waveform rendering function
  const renderWaveform = useCallback((canvas, containerWidth) => {
    if (!waveformLOD || !visibleTimeRange) return;

    const ctx = setupHighDPICanvas(canvas, containerWidth, height);
    const { start: visibleStart, end: visibleEnd } = visibleTimeRange;

    // Calculate rendering parameters
    const visibleDuration = visibleEnd - visibleStart;
    const pixelsPerSecond = containerWidth / visibleDuration;
    const samplesPerSecond = waveformLOD.levels[0].length / duration;
    const samplesPerPixel = samplesPerSecond / pixelsPerSecond;

    // Get appropriate LOD level for current zoom
    const lodData = waveformLOD.getLODLevel(samplesPerPixel);
    const lodSamplesPerSecond = lodData.length / duration;

    // Calculate visible sample range in LOD data
    const startSample = Math.floor(visibleStart * lodSamplesPerSecond);
    const endSample = Math.ceil(visibleEnd * lodSamplesPerSecond);
    const visibleSamples = endSample - startSample;

    // Clear canvas
    ctx.clearRect(0, 0, containerWidth, height);

    // Get theme colors
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const primaryColor = theme === 'dark' ? 'rgb(80, 200, 255)' : 'rgb(93, 95, 239)';
    const gradientColor = theme === 'dark' ? 'rgba(80, 200, 255, 0.3)' : 'rgba(93, 95, 239, 0.3)';

    // Create gradient for professional look
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, primaryColor);
    gradient.addColorStop(0.85, gradientColor);
    gradient.addColorStop(1, 'transparent');

    ctx.fillStyle = gradient;
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 0.5;

    // Render based on zoom level
    if (samplesPerPixel < 1) {
      // High zoom: Draw individual samples with interpolation
      renderHighZoom(ctx, lodData, startSample, endSample, containerWidth, height);
    } else if (samplesPerPixel < 10) {
      // Medium zoom: Draw with peak detection
      renderMediumZoom(ctx, lodData, startSample, endSample, containerWidth, height);
    } else {
      // Low zoom: Draw with efficient batching
      renderLowZoom(ctx, lodData, startSample, endSample, containerWidth, height);
    }

  }, [waveformLOD, visibleTimeRange, duration, height]);

  // High zoom rendering with smooth interpolation
  const renderHighZoom = (ctx, data, startSample, endSample, width, height) => {
    const samplesCount = endSample - startSample;
    const pixelsPerSample = width / samplesCount;

    ctx.beginPath();

    for (let i = 0; i < samplesCount; i++) {
      const sampleIndex = startSample + i;
      if (sampleIndex >= data.length) break;

      const x = i * pixelsPerSample;
      const amplitude = data[sampleIndex];
      const barHeight = amplitude * height * 0.9; // Leave 10% margin
      const y = height - barHeight;

      if (i === 0) {
        ctx.moveTo(x, height);
        ctx.lineTo(x, y);
      } else {
        // Smooth curves for professional look
        const prevX = (i - 1) * pixelsPerSample;
        const prevAmplitude = data[Math.max(0, startSample + i - 1)];
        const prevY = height - (prevAmplitude * height * 0.9);

        const cpX = (prevX + x) / 2;
        ctx.quadraticCurveTo(cpX, prevY, x, y);
      }
    }

    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  };

  // Medium zoom with peak detection
  const renderMediumZoom = (ctx, data, startSample, endSample, width, height) => {
    const pixelCount = Math.min(width, 2000); // Limit for performance
    const samplesPerPixel = (endSample - startSample) / pixelCount;

    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const sampleStart = startSample + Math.floor(pixel * samplesPerPixel);
      const sampleEnd = startSample + Math.floor((pixel + 1) * samplesPerPixel);

      // Find peak in this pixel range
      let peak = 0;
      for (let s = sampleStart; s < Math.min(sampleEnd, data.length); s++) {
        peak = Math.max(peak, data[s]);
      }

      const x = (pixel / pixelCount) * width;
      const barHeight = peak * height * 0.9;
      const y = height - barHeight;

      ctx.lineTo(x, y);
    }

    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  };

  // Low zoom with efficient batching
  const renderLowZoom = (ctx, data, startSample, endSample, width, height) => {
    const batchSize = Math.max(1, Math.floor((endSample - startSample) / width));
    const batches = Math.ceil((endSample - startSample) / batchSize);

    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let batch = 0; batch < batches; batch++) {
      const batchStart = startSample + batch * batchSize;
      const batchEnd = Math.min(batchStart + batchSize, endSample, data.length);

      // RMS calculation for this batch
      let sum = 0;
      let count = 0;
      for (let s = batchStart; s < batchEnd; s++) {
        sum += data[s] * data[s];
        count++;
      }

      const rms = count > 0 ? Math.sqrt(sum / count) : 0;
      const x = (batch / batches) * width;
      const barHeight = rms * height * 0.9;
      const y = height - barHeight;

      ctx.lineTo(x, y);
    }

    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  };

  // Optimized render function with intelligent caching
  const updateVisualization = useCallback(() => {
    if (!canvasRef.current || !containerRef.current || !waveformLOD) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    const containerWidth = container.clientWidth;

    // Create render signature for caching
    const renderParams = {
      width: containerWidth,
      height: height,
      start: visibleTimeRange.start,
      end: visibleTimeRange.end,
      theme: document.documentElement.getAttribute('data-theme') || 'light'
    };

    // Skip render if nothing changed (intelligent caching)
    if (lastRenderParamsRef.current &&
        JSON.stringify(lastRenderParamsRef.current) === JSON.stringify(renderParams)) {
      return;
    }

    lastRenderParamsRef.current = renderParams;

    // Render with appropriate technique based on container size
    if (containerWidth > 0) {
      renderWaveform(canvas, containerWidth);
      setHasDrawn(true);
    }
  }, [waveformLOD, visibleTimeRange, height, renderWaveform]);

  // Handle theme changes efficiently
  useEffect(() => {
    const handleThemeChange = () => {
      // Force re-render on theme change
      lastRenderParamsRef.current = null;
      updateVisualization();
    };

    // Listen for storage events (theme changes)
    window.addEventListener('storage', handleThemeChange);

    // Also listen for direct theme attribute changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          handleThemeChange();
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    return () => {
      window.removeEventListener('storage', handleThemeChange);
      observer.disconnect();
    };
  }, [updateVisualization]);

  // Main rendering effect with professional optimization
  useEffect(() => {
    if (!waveformLOD || !containerRef.current) return;

    // Immediate render
    updateVisualization();

    // Set up resize observer for responsive rendering
    const resizeObserver = new ResizeObserver(() => {
      // Debounce resize events
      clearTimeout(animationFrameRef.current);
      animationFrameRef.current = setTimeout(() => {
        lastRenderParamsRef.current = null; // Force re-render
        updateVisualization();
      }, 16); // ~60fps
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      if (animationFrameRef.current) {
        clearTimeout(animationFrameRef.current);
      }
      resizeObserver.disconnect();
    };
  }, [waveformLOD, updateVisualization]);

  // Handle visible range changes with smart throttling
  useEffect(() => {
    // Use requestAnimationFrame for smooth updates
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      updateVisualization();
    });

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [visibleTimeRange, updateVisualization]);

  // Professional canvas setup with high-DPI support
  const setupCanvas = useCallback((canvas) => {
    if (!canvas) return;

    canvasRef.current = canvas;

    // Enable high-DPI rendering
    const ctx = canvas.getContext('2d');

    // Set rendering optimizations
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Enable hardware acceleration hints
    ctx.globalCompositeOperation = 'source-over';

    // Initial render
    if (waveformLOD && containerRef.current) {
      updateVisualization();
    }
  }, [waveformLOD, updateVisualization]);

  // Don't render anything if there's no audio
  if (!hasAudio && isProcessed) {
    return null;
  }

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
        ref={setupCanvas}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          // Ensure crisp rendering
          imageRendering: 'pixelated',
          zIndex: 1
        }}
      />
      {((!waveformLOD && !hasDrawn) || isProcessing || (!isProcessed && !audioError)) && (
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
          <span className="material-symbols-rounded" style={{ fontSize: '16px', marginRight: '6px', animation: 'spin 1s linear infinite' }}>refresh</span>
          {t('waveform.processing', 'Processing audio waveform...')}
        </div>
      )}
      {!hasAudio && isProcessed && audioError && (
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
          No audio track
        </div>
      )}
    </div>
  );
};

export default VolumeVisualizer;
