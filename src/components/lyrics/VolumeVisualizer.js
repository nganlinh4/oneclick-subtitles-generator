import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';


// Global cache for audio data to avoid reprocessing the same audio
const audioDataCache = new Map();

// High-DPI canvas utilities for crisp rendering at any zoom level
const getDevicePixelRatio = () => window.devicePixelRatio || 1;

const setupHighDPICanvas = (canvas, width, height) => {
  const dpr = getDevicePixelRatio();
  // Set actual canvas size in memory (scaled up for high-DPI)
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  // Scale the canvas back down using CSS
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

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
function decodeWithTimeout(audioContext, arrayBuffer, timeoutMs = 30000) {
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
      console.log('[WAVEFORM] Processing after debounce:', {
        audioSource: currentSource?.substring(0, 100),
        duration: currentDuration
      });
      
      // Skip if we don't have a valid duration yet
      if (!currentDuration || currentDuration <= 0) {
        console.log('[WAVEFORM] Invalid duration, skipping processing for now');
        return;
      }
      
      // If we already have waveform data loaded, skip processing
      if (waveformLOD && isProcessed && processingSourceRef.current === currentSource) {
        console.log('[WAVEFORM] Already have waveform data for this source, skipping');
        return;
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

    const processAudio = async () => {
        // Check if this is a blob URL - blob URLs don't support range requests
        const isBlobUrl = currentSource.startsWith('blob:');
        
        // For long videos (regardless of source), we need to be smarter
        // If it's extremely long (over 1 hour) and a blob, we should still use segments to avoid memory issues
        const isExtremelyLong = currentDuration > 3600; // 1 hour
        const isLongAudioForCurrent = currentDuration > 300; // 5 minutes
        
        if (!isLongAudioForCurrent) {
            // Short audio - process entirely
            await processEntireAudio(localAbortController.signal);
        } else if (isExtremelyLong && isBlobUrl) {
            // Very long blob - we need to chunk it to avoid memory issues
            await processBlobInChunks(localAbortController.signal);
        } else if (!isBlobUrl) {
            // Long non-blob audio - use range requests for efficiency
            await processAudioInSegments(localAbortController.signal);
        } else {
            // Regular long blob (under 1 hour) - process entirely
            await processEntireAudio(localAbortController.signal);
        }
    };

    const processEntireAudio = async (signal) => {
        try {
            console.log('[WAVEFORM] Starting full audio processing for:', currentSource?.substring(0, 100));
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!audioContextRef.current) {
                audioContextRef.current = new AudioContext();
            }
            
            const response = await fetch(currentSource, { signal });
            console.log('[WAVEFORM] Fetched audio data, size:', response.headers.get('Content-Length'), 'bytes');
            const arrayBuffer = await response.arrayBuffer();
            
            // Use longer timeout for large files (over 50MB)
            const fileSize = arrayBuffer.byteLength;
            const timeoutMs = fileSize > 50 * 1024 * 1024 ? 60000 : 30000;
            console.log('[WAVEFORM] File size:', (fileSize / 1024 / 1024).toFixed(2), 'MB, timeout:', timeoutMs / 1000, 's');
            
            const audioBuffer = await decodeWithTimeout(audioContextRef.current, arrayBuffer, timeoutMs);
            console.log('[WAVEFORM] Audio decoded successfully, duration:', audioBuffer.duration, 's');

            if (!audioBuffer || audioBuffer.numberOfChannels === 0) {
              throw new Error('No audio channels found in the media file');
            }

            const channelData = audioBuffer.getChannelData(0);
            console.log('[WAVEFORM] Analyzing volume data...');
            const volumeData = await analyzeVolume(channelData);
            const finalLOD = new WaveformLOD(volumeData);
            
            if (!signal.aborted) {
                setWaveformLOD(finalLOD);
                audioDataCache.set(currentSource, finalLOD);
                console.log('[WAVEFORM] Processing complete');
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[WAVEFORM] Processing aborted (expected)');
                return;
            }
            console.error('[WAVEFORM] Full processing failed:', error);
            handleProcessingError(error);
        } finally {
            if (!signal.aborted) {
                setIsProcessing(false);
                setIsProcessed(true);
                if (processingSourceRef.current === currentSource) {
                    processingSourceRef.current = null;
                }
            }
        }
    };

    const processBlobInChunks = async (signal) => {
        try {
            console.log('[WAVEFORM] Starting chunked processing for long blob:', currentSource?.substring(0, 100), 'Duration:', duration, 's');
            setProcessingProgress(0);
            
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!audioContextRef.current) {
                audioContextRef.current = new AudioContext();
            }
            
            // Load the entire blob once (since we can't use range requests)
            console.log('[WAVEFORM] Fetching blob...');
            const response = await fetch(currentSource, { signal });
            const arrayBuffer = await response.arrayBuffer();
            console.log('[WAVEFORM] Blob loaded, size:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2), 'MB');
            
            if (signal.aborted) return;
            setProcessingProgress(0.1); // 10%
            
            console.log('[WAVEFORM] Decoding audio...');
            const audioBuffer = await decodeWithTimeout(audioContextRef.current, arrayBuffer, 60000);
            console.log('[WAVEFORM] Audio decoded, duration:', audioBuffer.duration, 's');
            
            if (signal.aborted) return;
            if (!audioBuffer || audioBuffer.numberOfChannels === 0) {
                throw new Error('No audio channels found in the media file');
            }
            
            const channelData = audioBuffer.getChannelData(0);
            const chunkDuration = 300; // 5 minutes per chunk
            const numChunks = Math.ceil(duration / chunkDuration);
            const samplesPerChunk = Math.floor(channelData.length / numChunks);
            let combinedVolumeData = new Float32Array();
            
            console.log('[WAVEFORM] Processing', numChunks, 'chunks,', samplesPerChunk, 'samples per chunk');
            
            for (let i = 0; i < numChunks; i++) {
                if (signal.aborted) {
                    console.log('[WAVEFORM] Processing aborted in chunk', i + 1);
                    return;
                }
                
                const startSample = i * samplesPerChunk;
                const endSample = Math.min(startSample + samplesPerChunk, channelData.length);
                const chunkData = channelData.subarray(startSample, endSample);
                
                console.log('[WAVEFORM] Processing chunk', i + 1, '/', numChunks, 'Progress:', ((i + 1) / numChunks * 90).toFixed(1) + '%');
                
                // Force UI update before processing each chunk
                setProcessingProgress(0.1 + (i / numChunks) * 0.8);
                await new Promise(resolve => setTimeout(resolve, 0));
                
                // Process this chunk immediately with synchronous analysis
                const chunkVolumeData = analyzeVolumeSync(chunkData, 500);
                
                // Update progress immediately after analysis
                const progress = 0.1 + ((i + 1) / numChunks) * 0.8;
                console.log('[WAVEFORM] Setting progress to', (progress * 100).toFixed(1) + '%');
                setProcessingProgress(progress);
                
                // Combine results and update UI progressively
                const newCombinedData = new Float32Array(combinedVolumeData.length + chunkVolumeData.length);
                newCombinedData.set(combinedVolumeData);
                newCombinedData.set(chunkVolumeData, combinedVolumeData.length);
                combinedVolumeData = newCombinedData;
                
                if (!signal.aborted) {
                    const waveformLOD = new WaveformLOD(combinedVolumeData);
                    console.log('[WAVEFORM] Created LOD with', combinedVolumeData.length, 'samples');
                    setWaveformLOD(waveformLOD);
                }
                
                // Small delay to ensure UI updates
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            
            if (!signal.aborted) {
                console.log('[WAVEFORM] Setting final progress to 100%');
                setProcessingProgress(1.0);
                
                audioDataCache.set(currentSource, new WaveformLOD(combinedVolumeData));
                console.log('[WAVEFORM] Chunked processing complete, combined data length:', combinedVolumeData.length);
                
                // Small delay before finishing
                setTimeout(() => {
                    setIsProcessing(false);
                    setIsProcessed(true);
                    if (processingSourceRef.current === currentSource) {
                        processingSourceRef.current = null;
                    }
                }, 100);
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[WAVEFORM] Chunked processing aborted (expected)');
                setIsProcessing(false);
                return;
            }
            console.error('[WAVEFORM] Chunked processing failed:', error);
            setIsProcessing(false);
            handleProcessingError(error);
            if (processingSourceRef.current === currentSource) {
                processingSourceRef.current = null;
            }
        }
    };

    const processAudioInSegments = async (signal) => {
        try {
            console.log('[WAVEFORM] Starting segmented processing for long audio:', currentSource?.substring(0, 100));
            setProcessingProgress(0);
            
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!audioContextRef.current) {
                audioContextRef.current = new AudioContext();
            }
            
            // First, get the total file size to estimate byte ranges for segments
            const headResponse = await fetch(currentSource, { method: 'HEAD', signal });
            const fileSize = Number(headResponse.headers.get('Content-Length'));
            const acceptRanges = headResponse.headers.get('Accept-Ranges');

            if (!fileSize || !acceptRanges?.includes('bytes')) {
                 console.warn('[WAVEFORM] Server does not support range requests or file size is unknown. Falling back to processing the entire file.');
                 await processEntireAudio(signal);
                 return;
            }

            const segmentDuration = 300; // 5 minutes per segment
            const numSegments = Math.ceil(duration / segmentDuration);
            const bytesPerSecond = fileSize / duration;
            let combinedVolumeData = new Float32Array();

            console.log('[WAVEFORM] Processing', numSegments, 'segments, file size:', (fileSize / 1024 / 1024).toFixed(2), 'MB');
            setProcessingProgress(0.05); // 5%

            for (let i = 0; i < numSegments; i++) {
                if (signal.aborted) {
                    console.log('[WAVEFORM] Processing aborted in segment', i + 1);
                    return;
                }

                const startTime = i * segmentDuration;
                const endTime = Math.min((i + 1) * segmentDuration, duration);
                
                const startByte = Math.floor(startTime * bytesPerSecond);
                const endByte = Math.floor(endTime * bytesPerSecond) - 1;

                console.log('[WAVEFORM] Processing segment', i + 1, '/', numSegments, 'Time:', startTime, '-', endTime, 's');

                // Update progress before fetching
                const progress = 0.05 + (i / numSegments) * 0.9;
                setProcessingProgress(progress);
                await new Promise(resolve => setTimeout(resolve, 0));

                const rangeResponse = await fetch(currentSource, {
                    headers: { 'Range': `bytes=${startByte}-${endByte}` },
                    signal
                });
                
                if (!rangeResponse.ok) {
                    console.warn('[WAVEFORM] Range request failed, falling back to processing entire file:', rangeResponse.status);
                    await processEntireAudio(signal);
                    return;
                }
                
                const arrayBuffer = await rangeResponse.arrayBuffer();
                const audioBuffer = await decodeWithTimeout(audioContextRef.current, arrayBuffer.slice(0), 15000);

                if (audioBuffer.numberOfChannels > 0) {
                    const channelData = audioBuffer.getChannelData(0);
                    const segmentVolumeData = await analyzeVolume(channelData, 1000);
                    
                    // Combine results and update UI progressively
                    const newCombinedData = new Float32Array(combinedVolumeData.length + segmentVolumeData.length);
                    newCombinedData.set(combinedVolumeData);
                    newCombinedData.set(segmentVolumeData, combinedVolumeData.length);
                    combinedVolumeData = newCombinedData;
                    
                    if (!signal.aborted) {
                       setWaveformLOD(new WaveformLOD(combinedVolumeData));
                       console.log('[WAVEFORM] Updated with', combinedVolumeData.length, 'samples, progress:', ((i + 1) / numSegments * 100).toFixed(1) + '%');
                    }
                }
                 // Yield to the main thread to allow UI updates
                 await new Promise(resolve => setTimeout(resolve, 0));
            }

            if (!signal.aborted) {
                setProcessingProgress(1.0);
                audioDataCache.set(currentSource, new WaveformLOD(combinedVolumeData));
                console.log('[WAVEFORM] Segmented processing complete, data length:', combinedVolumeData.length);
                
                setIsProcessing(false);
                setIsProcessed(true);
                if (processingSourceRef.current === currentSource) {
                    processingSourceRef.current = null;
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[WAVEFORM] Segmented processing aborted (expected)');
                setIsProcessing(false);
                return;
            }
            console.error('[WAVEFORM] Segmented processing failed:', error);
            setIsProcessing(false);
            handleProcessingError(error);
            if (processingSourceRef.current === currentSource) {
                processingSourceRef.current = null;
            }
        }
    };
    
    const analyzeVolume = async (channelData, sampleSize = 1000) => {
        const samplesPerSegment = Math.floor(channelData.length / sampleSize);
        const volumeData = new Float32Array(sampleSize);
        let maxVolume = 0;

        // First pass: calculate RMS and find max
        for (let i = 0; i < sampleSize; i++) {
            const startSample = i * samplesPerSegment;
            const endSample = Math.min(startSample + samplesPerSegment, channelData.length);
            let sum = 0;
            let count = 0;
            for (let j = startSample; j < endSample; j++) {
                sum += channelData[j] * channelData[j];
                count++;
            }
            const rms = count > 0 ? Math.sqrt(sum / count) : 0;
            volumeData[i] = rms;
            if (rms > maxVolume) maxVolume = rms;
            
            if (i % 50 === 0) { // More frequent yielding for better UI responsiveness
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        
        // Second pass: normalize and apply curve
        if (maxVolume > 0) {
            for (let i = 0; i < volumeData.length; i++) {
                // Normalize to 0-1
                let normalized = volumeData[i] / maxVolume;
                
                // Apply gentle curve
                normalized = Math.pow(normalized, 0.75);
                
                // Add small floor to ensure visibility of quiet sections
                volumeData[i] = Math.max(normalized, 0.01);
            }
        } else {
            // If no volume detected, set minimum values
            for (let i = 0; i < volumeData.length; i++) {
                volumeData[i] = 0.01;
            }
        }
        
        return volumeData;
    };
    
    const analyzeVolumeSync = (channelData, sampleSize = 1000) => {
        const samplesPerSegment = Math.floor(channelData.length / sampleSize);
        const volumeData = new Float32Array(sampleSize);
        let maxVolume = 0;

        // Calculate RMS and find max - synchronous for better performance
        for (let i = 0; i < sampleSize; i++) {
            const startSample = i * samplesPerSegment;
            const endSample = Math.min(startSample + samplesPerSegment, channelData.length);
            let sum = 0;
            let count = 0;
            for (let j = startSample; j < endSample; j++) {
                sum += channelData[j] * channelData[j];
                count++;
            }
            const rms = count > 0 ? Math.sqrt(sum / count) : 0;
            volumeData[i] = rms;
            if (rms > maxVolume) maxVolume = rms;
        }
        
        // Normalize and apply curve
        if (maxVolume > 0) {
            for (let i = 0; i < volumeData.length; i++) {
                // Normalize to 0-1
                let normalized = volumeData[i] / maxVolume;
                
                // Apply gentle curve
                normalized = Math.pow(normalized, 0.75);
                
                // Add small floor to ensure visibility of quiet sections
                volumeData[i] = Math.max(normalized, 0.01);
            }
        } else {
            // If no volume detected, set minimum values
            for (let i = 0; i < volumeData.length; i++) {
                volumeData[i] = 0.01;
            }
        }
        
        return volumeData;
    };
    
    const handleProcessingError = (error) => {
        if (error.name === 'AbortError') {
          console.log('[WAVEFORM] Processing aborted.');
          return;
        }
        console.error('[WAVEFORM] ❌ Error processing audio:', error);
        if (error.name === 'EncodingError' || error.message.includes('decode')) {
          setHasAudio(false);
          setAudioError('No audio track found or it is corrupted.');
          audioDataCache.set(currentSource, 'NO_AUDIO');
        } else {
          setAudioError(`Audio processing failed: ${error.message}`);
        }
    };

    processAudio();

      // Cleanup function
      return () => {
        if (localAbortController) {
          try {
            console.log('[WAVEFORM] Cleanup: aborting fetch');
            localAbortController.abort();
          } catch {}
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

  // Waveform rendering function (unchanged)
  const renderWaveform = useCallback((canvas, containerWidth) => {
    if (!waveformLOD || !visibleTimeRange || !duration) return;

    const ctx = setupHighDPICanvas(canvas, containerWidth, height);
    const { start: visibleStart, end: visibleEnd } = visibleTimeRange;

    const visibleDuration = visibleEnd - visibleStart;
    const pixelsPerSecond = containerWidth / visibleDuration;
    
    // Correctly map time to samples
    const totalDataLength = waveformLOD.levels[0].length; // Actual data length
    const samplesPerSecond = totalDataLength / duration; // Real samples per second
    const samplesPerPixel = samplesPerSecond / pixelsPerSecond;

    const lodData = waveformLOD.getLODLevel(samplesPerPixel);
    
    // Map visible time range to sample indices
    const startSample = Math.max(0, Math.floor(visibleStart * samplesPerSecond));
    const endSample = Math.min(lodData.length, Math.ceil(visibleEnd * samplesPerSecond));
    const samplesToDraw = endSample - startSample;

    console.log('[WAVEFORM] Rendering:', {
      duration: duration,
      totalDataLength: totalDataLength,
      samplesPerSecond: samplesPerSecond,
      visibleStart: visibleStart,
      visibleEnd: visibleEnd,
      startSample: startSample,
      endSample: endSample,
      samplesToDraw: samplesToDraw,
      containerWidth: containerWidth
    });

    ctx.clearRect(0, 0, containerWidth, height);
    
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const primaryColor = theme === 'dark' ? 'rgb(80, 200, 255)' : 'rgb(93, 95, 239)';
    const gradientColor = theme === 'dark' ? 'rgba(80, 200, 255, 0.3)' : 'rgba(93, 95, 239, 0.3)';

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, primaryColor);
    gradient.addColorStop(0.85, gradientColor);
    gradient.addColorStop(1, 'transparent');
    ctx.fillStyle = gradient;

    if (samplesToDraw <= 0) return;

    const pixelsPerSample = containerWidth / samplesToDraw;

    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let i = 0; i < samplesToDraw; i++) {
        const sampleIndex = startSample + i;
        if (sampleIndex >= lodData.length) break;
        
        const x = i * pixelsPerSample;
        const amplitude = lodData[sampleIndex] || 0;
        const barHeight = Math.max(amplitude * height * 0.9, 0.5); // Reduced minimum height
        const y = height - barHeight;
        
        ctx.lineTo(x, y);
    }
    
    ctx.lineTo(containerWidth, height);
    ctx.closePath();
    ctx.fill();

    console.log('[WAVEFORM] Rendered', samplesToDraw, 'samples, amplitude range:', {
      min: Math.min(...lodData.slice(startSample, endSample)),
      max: Math.max(...lodData.slice(startSample, endSample))
    });

  }, [waveformLOD, visibleTimeRange, duration, height]);
  
  // Update visualization function (unchanged)
  const updateVisualization = useCallback(() => {
    if (!canvasRef.current || !containerRef.current || !waveformLOD) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const containerWidth = container.clientWidth;

    const renderParams = {
      width: containerWidth,
      height: height,
      start: visibleTimeRange.start,
      end: visibleTimeRange.end,
      theme: document.documentElement.getAttribute('data-theme') || 'light',
      dataLength: waveformLOD.levels[0].length
    };
    
    if (lastRenderParamsRef.current && JSON.stringify(lastRenderParamsRef.current) === JSON.stringify(renderParams)) {
      return;
    }

    lastRenderParamsRef.current = renderParams;

    if (containerWidth > 0) {
      renderWaveform(canvas, containerWidth);
    }
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