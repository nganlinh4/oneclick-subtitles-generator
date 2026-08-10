// Async audio fetch/decode/analyze pipelines for the volume visualizer.
// These do not close over component state; everything they need (setters,
// refs, the current source/duration, the cache, and a debug logger) is passed
// in via the `ctx` object so the logic stays identical to the original inline
// implementations.

import { WaveformLOD, decodeWithTimeout } from './waveformLOD';
import { analyzeVolume, analyzeVolumeSync } from './audioAnalysis';
import { runMediaPipeline } from '../../platform/mediaPipelineService';
import { isNativeMediaPlaybackUrl } from '../../platform/mediaService';
import { fetchBrowserResource } from '../../platform/browserFetch';

// ctx shape:
// {
//   currentSource, currentDuration, duration,
//   audioContextRef, processingSourceRef,
//   audioDataCache, dbgWave,
//   setWaveformLOD, setIsProcessing, setIsProcessed,
//   setHasAudio, setAudioError, setProcessingProgress,
// }

const handleProcessingError = (ctx, error) => {
    const { dbgWave, currentSource, audioDataCache, setHasAudio, setAudioError } = ctx;
    if (error.name === 'AbortError') {
      dbgWave('[WAVEFORM] Processing aborted.');
      return;
    }
    console.error('[WAVEFORM] ❌ Error processing audio:', error);
    if (error.code === 'mediaMissingAudio'
        || error.name === 'EncodingError'
        || (typeof error.message === 'string' && error.message.includes('decode'))) {
      setHasAudio(false);
      setAudioError('No audio track found or it is corrupted.');
      audioDataCache.set(currentSource, 'NO_AUDIO');
    } else {
      setAudioError(`Audio processing failed: ${error.message}`);
    }
};

const rejectNativeCapabilityFetch = (source) => {
    if (!isNativeMediaPlaybackUrl(source)) return;
    const error = new Error('Native media must be analyzed through the desktop media pipeline');
    error.name = 'SecurityError';
    error.code = 'nativeCapabilityFetchBlocked';
    throw error;
};

export const waveformPyramidToLegacySamples = (waveform) => {
    const points = waveform?.levels?.[0]?.points;
    if (!Array.isArray(points) || points.length === 0) return new Float32Array();

    let maximum = 0;
    points.forEach((point) => {
        maximum = Math.max(maximum, point.rootMeanSquare);
    });
    return Float32Array.from(points, (point) => (
        maximum > 0
            ? Math.max(Math.pow(point.rootMeanSquare / maximum, 0.75), 0.01)
            : 0.01
    ));
};

const nativeWaveformDensity = (duration) => {
    const pointsPerSecond = duration > 300
        ? 4
        : Math.min(400, Math.max(1, Math.ceil(1000 / duration)));
    return Object.freeze({
        pointsPerSecond,
        maxPoints: Math.min(1_000_000, Math.max(1_000, Math.ceil(duration * pointsPerSecond))),
    });
};

export const processNativeWaveform = async (ctx, assetId, signal) => {
    const {
        currentSource, currentDuration,
        processingSourceRef, audioDataCache, dbgWave,
        setWaveformLOD, setIsProcessing, setIsProcessed, setProcessingProgress,
    } = ctx;
    let lastProgress = 0;
    try {
        const density = nativeWaveformDensity(currentDuration);
        dbgWave('[WAVEFORM] Starting native waveform analysis for:', assetId);
        const result = await runMediaPipeline({
            operation: 'generateWaveform',
            assetId,
            pointsPerSecond: density.pointsPerSecond,
            maxPoints: density.maxPoints,
            range: null,
        }, {
            signal,
            onProgress: (event) => {
                const next = event.fraction ?? event.job.progress.basisPoints / 10_000;
                lastProgress = Math.max(lastProgress, next);
                setProcessingProgress(lastProgress);
            },
        });
        const samples = waveformPyramidToLegacySamples(result.waveform);
        if (samples.length === 0) {
            const error = new Error('No audio channels found in the media file');
            error.name = 'EncodingError';
            throw error;
        }
        const finalLOD = new WaveformLOD(samples);
        if (!signal.aborted) {
            setProcessingProgress(1);
            setWaveformLOD(finalLOD);
            audioDataCache.set(currentSource, finalLOD);
            dbgWave('[WAVEFORM] Native waveform analysis complete');
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            dbgWave('[WAVEFORM] Native waveform analysis aborted (expected)');
            return;
        }
        handleProcessingError(ctx, error);
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

export const processEntireAudio = async (ctx, signal) => {
    const {
        currentSource, currentDuration,
        audioContextRef, processingSourceRef,
        audioDataCache, dbgWave,
        setWaveformLOD, setIsProcessing, setIsProcessed,
    } = ctx;
    try {
        rejectNativeCapabilityFetch(currentSource);
        dbgWave('[WAVEFORM] Starting full audio processing for:', currentSource?.substring(0, 100));
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext();
        }

        const response = await fetchBrowserResource(currentSource, { signal });
        dbgWave('[WAVEFORM] Fetched audio data, size:', response.headers.get('Content-Length'), 'bytes');
        const arrayBuffer = await response.arrayBuffer();

        // Use longer timeout for large files (over 50MB)
        const fileSize = arrayBuffer.byteLength;
        const timeoutMs = fileSize > 50 * 1024 * 1024 ? 60000 : 30000;
        dbgWave('[WAVEFORM] File size:', (fileSize / 1024 / 1024).toFixed(2), 'MB, timeout:', timeoutMs / 1000, 's');

        const audioBuffer = await decodeWithTimeout(audioContextRef.current, arrayBuffer, timeoutMs);
        dbgWave('[WAVEFORM] Audio decoded successfully, duration:', audioBuffer.duration, 's');

        if (!audioBuffer || audioBuffer.numberOfChannels === 0) {
          throw new Error('No audio channels found in the media file');
        }

        const channelData = audioBuffer.getChannelData(0);
        dbgWave('[WAVEFORM] Analyzing volume data...');
        // Clamp analysis to video duration to avoid waveform extending beyond video
        const volumeData = await analyzeVolume(channelData, 1000, audioBuffer.duration, currentDuration);
        const finalLOD = new WaveformLOD(volumeData);

        if (!signal.aborted) {
            setWaveformLOD(finalLOD);
            audioDataCache.set(currentSource, finalLOD);
            dbgWave('[WAVEFORM] Processing complete');
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            dbgWave('[WAVEFORM] Processing aborted (expected)');
            return;
        }
        console.error('[WAVEFORM] Full processing failed:', error);
        handleProcessingError(ctx, error);
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

export const processBlobInChunks = async (ctx, signal) => {
    const {
        currentSource, duration,
        audioContextRef, processingSourceRef,
        audioDataCache, dbgWave,
        setWaveformLOD, setIsProcessing, setIsProcessed, setProcessingProgress,
    } = ctx;
    try {
        rejectNativeCapabilityFetch(currentSource);
        dbgWave('[WAVEFORM] Starting chunked processing for long blob:', currentSource?.substring(0, 100), 'Duration:', duration, 's');
        setProcessingProgress(0);

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext();
        }

        // Load the entire blob once (since we can't use range requests)
        dbgWave('[WAVEFORM] Fetching blob...');
        const response = await fetchBrowserResource(currentSource, { signal });
        const arrayBuffer = await response.arrayBuffer();
        dbgWave('[WAVEFORM] Blob loaded, size:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2), 'MB');

        if (signal.aborted) return;
        setProcessingProgress(0.1); // 10%

        dbgWave('[WAVEFORM] Decoding audio...');
        const audioBuffer = await decodeWithTimeout(audioContextRef.current, arrayBuffer, 60000);
        dbgWave('[WAVEFORM] Audio decoded, duration:', audioBuffer.duration, 's');

        if (signal.aborted) return;
        if (!audioBuffer || audioBuffer.numberOfChannels === 0) {
            throw new Error('No audio channels found in the media file');
        }

        const channelData = audioBuffer.getChannelData(0);
        const chunkDuration = 300; // 5 minutes per chunk
        const numChunks = Math.ceil(duration / chunkDuration);
        const samplesPerChunk = Math.floor(channelData.length / numChunks);
        let combinedVolumeData = new Float32Array();

        dbgWave('[WAVEFORM] Processing', numChunks, 'chunks,', samplesPerChunk, 'samples per chunk');

        for (let i = 0; i < numChunks; i++) {
            if (signal.aborted) {
                dbgWave('[WAVEFORM] Processing aborted in chunk', i + 1);
                return;
            }

            const startSample = i * samplesPerChunk;
            const endSample = Math.min(startSample + samplesPerChunk, channelData.length);
            const chunkData = channelData.subarray(startSample, endSample);

            dbgWave('[WAVEFORM] Processing chunk', i + 1, '/', numChunks, 'Progress:', ((i + 1) / numChunks * 90).toFixed(1) + '%');

            // Force UI update before processing each chunk
            setProcessingProgress(0.1 + (i / numChunks) * 0.8);
            await new Promise(resolve => setTimeout(resolve, 0));

            // Process this chunk immediately with synchronous analysis
            const chunkDuration = (endSample - startSample) / channelData.length * audioBuffer.duration;
            const chunkVolumeData = analyzeVolumeSync(chunkData, 500, chunkDuration, chunkDuration);

            // Update progress immediately after analysis
            const progress = 0.1 + ((i + 1) / numChunks) * 0.8;
            dbgWave('[WAVEFORM] Setting progress to', (progress * 100).toFixed(1) + '%');
            setProcessingProgress(progress);

            // Combine results and update UI progressively
            const newCombinedData = new Float32Array(combinedVolumeData.length + chunkVolumeData.length);
            newCombinedData.set(combinedVolumeData);
            newCombinedData.set(chunkVolumeData, combinedVolumeData.length);
            combinedVolumeData = newCombinedData;

            if (!signal.aborted) {
                const waveformLOD = new WaveformLOD(combinedVolumeData);
                dbgWave('[WAVEFORM] Created LOD with', combinedVolumeData.length, 'samples');
                setWaveformLOD(waveformLOD);
            }

            // Small delay to ensure UI updates
            await new Promise(resolve => setTimeout(resolve, 1));
        }

        if (!signal.aborted) {
            dbgWave('[WAVEFORM] Setting final progress to 100%');
            setProcessingProgress(1.0);

            audioDataCache.set(currentSource, new WaveformLOD(combinedVolumeData));
            dbgWave('[WAVEFORM] Chunked processing complete, combined data length:', combinedVolumeData.length);

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
            dbgWave('[WAVEFORM] Chunked processing aborted (expected)');
            setIsProcessing(false);
            return;
        }
        console.error('[WAVEFORM] Chunked processing failed:', error);
        setIsProcessing(false);
        handleProcessingError(ctx, error);
        if (processingSourceRef.current === currentSource) {
            processingSourceRef.current = null;
        }
    }
};

export const processAudioInSegments = async (ctx, signal) => {
    const {
        currentSource, duration,
        audioContextRef, processingSourceRef,
        audioDataCache, dbgWave,
        setWaveformLOD, setIsProcessing, setIsProcessed, setProcessingProgress,
    } = ctx;
    try {
        rejectNativeCapabilityFetch(currentSource);
        dbgWave('[WAVEFORM] Starting segmented processing for long audio:', currentSource?.substring(0, 100));
        setProcessingProgress(0);

        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext();
        }

        // First, get the total file size to estimate byte ranges for segments
        const headResponse = await fetchBrowserResource(currentSource, { method: 'HEAD', signal });
        const fileSize = Number(headResponse.headers.get('Content-Length'));
        const acceptRanges = headResponse.headers.get('Accept-Ranges');

        if (!fileSize || !acceptRanges?.includes('bytes')) {
             console.warn('[WAVEFORM] Server does not support range requests or file size is unknown. Falling back to processing the entire file.');
             await processEntireAudio(ctx, signal);
             return;
        }

        const segmentDuration = 300; // 5 minutes per segment
        const numSegments = Math.ceil(duration / segmentDuration);
        const bytesPerSecond = fileSize / duration;
        let combinedVolumeData = new Float32Array();

        dbgWave('[WAVEFORM] Processing', numSegments, 'segments, file size:', (fileSize / 1024 / 1024).toFixed(2), 'MB');
        setProcessingProgress(0.05); // 5%

        for (let i = 0; i < numSegments; i++) {
            if (signal.aborted) {
                dbgWave('[WAVEFORM] Processing aborted in segment', i + 1);
                return;
            }

            const startTime = i * segmentDuration;
            const endTime = Math.min((i + 1) * segmentDuration, duration);

            const startByte = Math.floor(startTime * bytesPerSecond);
            const endByte = Math.floor(endTime * bytesPerSecond) - 1;

            dbgWave('[WAVEFORM] Processing segment', i + 1, '/', numSegments, 'Time:', startTime, '-', endTime, 's');

            // Update progress before fetching
            const progress = 0.05 + (i / numSegments) * 0.9;
            setProcessingProgress(progress);
            await new Promise(resolve => setTimeout(resolve, 0));

            const rangeResponse = await fetchBrowserResource(currentSource, {
                headers: { 'Range': `bytes=${startByte}-${endByte}` },
                signal
            });

            if (!rangeResponse.ok) {
                console.warn('[WAVEFORM] Range request failed, falling back to processing entire file:', rangeResponse.status);
                await processEntireAudio(ctx, signal);
                return;
            }

            const arrayBuffer = await rangeResponse.arrayBuffer();
            const audioBuffer = await decodeWithTimeout(audioContextRef.current, arrayBuffer.slice(0), 15000);

            if (audioBuffer.numberOfChannels > 0) {
                const channelData = audioBuffer.getChannelData(0);
                const segmentVolumeData = await analyzeVolume(channelData, 1000, audioBuffer.duration, endTime - startTime);

                // Combine results and update UI progressively
                const newCombinedData = new Float32Array(combinedVolumeData.length + segmentVolumeData.length);
                newCombinedData.set(combinedVolumeData);
                newCombinedData.set(segmentVolumeData, combinedVolumeData.length);
                combinedVolumeData = newCombinedData;

                if (!signal.aborted) {
                   setWaveformLOD(new WaveformLOD(combinedVolumeData));
                   dbgWave('[WAVEFORM] Updated with', combinedVolumeData.length, 'samples, progress:', ((i + 1) / numSegments * 100).toFixed(1) + '%');
                }
            }
             // Yield to the main thread to allow UI updates
             await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (!signal.aborted) {
            setProcessingProgress(1.0);
            audioDataCache.set(currentSource, new WaveformLOD(combinedVolumeData));
            dbgWave('[WAVEFORM] Segmented processing complete, data length:', combinedVolumeData.length);

            setIsProcessing(false);
            setIsProcessed(true);
            if (processingSourceRef.current === currentSource) {
                processingSourceRef.current = null;
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            dbgWave('[WAVEFORM] Segmented processing aborted (expected)');
            setIsProcessing(false);
            return;
        }
        console.error('[WAVEFORM] Segmented processing failed:', error);
        setIsProcessing(false);
        handleProcessingError(ctx, error);
        if (processingSourceRef.current === currentSource) {
            processingSourceRef.current = null;
        }
    }
};
