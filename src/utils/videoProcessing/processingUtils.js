/**
 * Legacy processing utilities for video/audio processing
 * @deprecated These functions are deprecated. Use simplifiedProcessing.js instead.
 *
 * This file provides backward compatibility for legacy code that still uses
 * the old segment-based processing approach. All functions now redirect to
 * the new simplified processing system for better performance.
 */
// Debug logging gate (enable by setting localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };
const dbgw = (...args) => { if (DEBUG_LOGS) console.warn(...args); };

/**
 * Process a short video/audio file (shorter than max segment duration)
 * @deprecated Use processVideoWithFilesApi from simplifiedProcessing.js instead
 * @param {File} mediaFile - The media file
 * @param {Function} onStatusUpdate - Callback for status updates
 * @param {Function} t - Translation function
 * @param {Object} options - Processing options
 * @returns {Promise<Array>} - Array of subtitle objects
 */
export const processShortMedia = async (mediaFile, onStatusUpdate, t, options = {}) => {
  dbgw('[LEGACY] processShortMedia is deprecated. Redirecting to simplified processing.');

  // Show a helpful message to the user
  onStatusUpdate({
    message: t('output.usingLegacyFallback', 'Using legacy processing. Enable "Simplified Processing" in settings for better performance.'),
    type: 'warning'
  });

  // Redirect to simplified processing
  const { processVideoWithFilesApi } = await import('./simplifiedProcessing');
  return await processVideoWithFilesApi(mediaFile, onStatusUpdate, t, options);
};

/**
 * Process a long video/audio file by splitting it into segments
 * @deprecated Use processVideoWithFilesApi from simplifiedProcessing.js instead
 * @param {File} mediaFile - The media file
 * @param {Function} onStatusUpdate - Callback for status updates
 * @param {Function} t - Translation function
 * @param {Object} options - Processing options
 * @returns {Promise<Array>} - Array of subtitle objects
 */
export const processLongVideo = async (mediaFile, onStatusUpdate, t, options = {}) => {
  dbgw('[LEGACY] processLongVideo is deprecated. Redirecting to simplified processing.');

  // Show a helpful message to the user
  onStatusUpdate({
    message: t('output.usingLegacyFallback', 'Using legacy processing. Enable "Simplified Processing" in settings for better performance.'),
    type: 'warning'
  });

  // Redirect to simplified processing
  const { processVideoWithFilesApi } = await import('./simplifiedProcessing');
  return await processVideoWithFilesApi(mediaFile, onStatusUpdate, t, options);
};

/**
 * Alias for processLongVideo to maintain backward compatibility
 * @deprecated Use processVideoWithFilesApi from simplifiedProcessing.js instead
 */
export const processLongMedia = processLongVideo;

/**
 * Map UI media resolution values to Gemini API enum values
 */
const mapMediaResolution = (resolution) => {
  const resolutionMap = {
    'low': 'MEDIA_RESOLUTION_LOW',
    'medium': 'MEDIA_RESOLUTION_MEDIUM'
  };
  return resolutionMap[resolution] || 'MEDIA_RESOLUTION_MEDIUM';
};

/**
 * Process a specific segment of video using Files API with custom options
 * This is the new segment-based processing function for the improved workflow
 */
export const processSegmentWithFilesApi = async (file, segment, options, setStatus, t) => {
  try {
    const { fps, mediaResolution, model, userProvidedSubtitles } = options;

    setStatus({
      message: t('processing.processingSegment', 'Processing selected segment (reusing uploaded file)...'),
      type: 'loading'
    });

    // Prepare video metadata for segment processing
    // Using string format that was working before
    const videoMetadata = {
      start_offset: `${Math.floor(segment.start)}s`,
      end_offset: `${Math.floor(segment.end)}s`,
      fps: fps
    };

    // Map media resolution to API enum value
    const mappedMediaResolution = mapMediaResolution(mediaResolution);

    // Prepare options for the Files API call
    const apiOptions = {
      userProvidedSubtitles,
      modelId: model,
      videoMetadata,
      mediaResolution: mappedMediaResolution,
      segmentInfo: {
        start: segment.start,
        end: segment.end,
        duration: segment.end - segment.start
      }
    };

    // Call the Gemini API with Files API
    const { callGeminiApiWithFilesApi } = await import('../../services/gemini');
    const result = await callGeminiApiWithFilesApi(file, apiOptions);

    return result;
  } catch (error) {
    console.error('Error processing segment with Files API:', error);
    throw error;
  }
};

/**
 * Process a specific segment with streaming support
 * @param {File} file - The media file
 * @param {Object} segment - Segment with start/end times
 * @param {Object} options - Processing options
 * @param {Function} setStatus - Status update callback
 * @param {Function} onSubtitleUpdate - Real-time subtitle update callback
 * @param {Function} t - Translation function
 * @returns {Promise<Array>} - Final subtitle array
 */
export const processSegmentWithStreaming = async (file, segment, options, setStatus, onSubtitleUpdate, t) => {
  return new Promise((resolve, reject) => {
    const { fps, mediaResolution, model, userProvidedSubtitles, autoSplitSubtitles, maxWordsPerSubtitle } = options;

    // Check if this is a Gemini 2.0 model (they don't respect video_metadata offsets)
    const isGemini20Model = model && (model.includes('gemini-2.0') || model.includes('gemini-1.5'));
    if (isGemini20Model) {
      dbgw(`[ProcessingUtils] Model ${model} may not respect video segment offsets - will filter results and use early stopping`);
    }

    // Track if we've stopped early due to subtitles going past segment
    let hasStoppedEarly = false;
    let earlyStopController = null;

    // Import streaming processor
    import('../../utils/subtitle/realtimeProcessor').then(({ createRealtimeProcessor }) => {
      // Create realtime processor with auto-split options from the modal
      // Convert to boolean properly - the value comes as a boolean from the modal
      const processor = createRealtimeProcessor({
        autoSplitEnabled: Boolean(autoSplitSubtitles),
        maxWordsPerSubtitle: parseInt(maxWordsPerSubtitle) || 8,
        onSubtitleUpdate: (data) => {
          // console.log('[ProcessingUtils] Subtitle update:', data.subtitles.length, 'subtitles');

          // For Gemini 2.0 models: implement early stopping when subtitles exceed segment
          if (isGemini20Model && data.subtitles && data.subtitles.length > 0 && !hasStoppedEarly) {
            const segmentStart = segment.start;
            const segmentEnd = segment.end;

            // Check if we have subtitles that are significantly past the segment end
            // We add a small buffer (5 seconds) to avoid stopping too early
            const bufferTime = 5;
            const lastSubtitle = data.subtitles[data.subtitles.length - 1];

            if (lastSubtitle && lastSubtitle.start > (segmentEnd + bufferTime)) {
              dbgw(`[ProcessingUtils] Early stopping: Last subtitle at ${lastSubtitle.start}s exceeds segment end ${segmentEnd}s by more than ${bufferTime}s`);
              hasStoppedEarly = true;

              // Trigger early completion with filtered subtitles
              const filteredForCompletion = data.subtitles.filter(sub => {
                return sub.start < segmentEnd && sub.end > segmentStart;
              }).map(sub => {
                return {
                  ...sub,
                  start: Math.max(sub.start, segmentStart),
                  end: Math.min(sub.end, segmentEnd)
                };
              });

              dbg(`[ProcessingUtils] Early stop: Completing with ${filteredForCompletion.length} subtitles (from ${data.subtitles.length} total)`);

              // Cancel the streaming if we have a controller
              if (earlyStopController && typeof earlyStopController.abort === 'function') {
                earlyStopController.abort();
              }

              // Manually trigger completion
              processor.complete(JSON.stringify(filteredForCompletion));
              return; // Stop processing further updates
            }
          }

          // Normalize potential relative times to absolute BEFORE filtering/clipping
          let filteredSubtitles = data.subtitles;
          if (data.subtitles && data.subtitles.length > 0) {
            const segmentStart = segment.start;
            const segmentEnd = segment.end;
            const segDuration = segmentEnd - segmentStart;

            // Detect segment-relative timestamps from the model and offset first
            const maxEndRaw = Math.max(...data.subtitles.map(s => s.end || 0));
            const looksRelative = maxEndRaw <= (segDuration + 1);
            let normalized = looksRelative
              ? data.subtitles.map(sub => ({
                  ...sub,
                  start: (sub.start || 0) + segmentStart,
                  end: (sub.end || 0) + segmentStart
                }))
              : data.subtitles;

            // Then filter and clip
            filteredSubtitles = normalized.filter(sub => (sub.start < segmentEnd && sub.end > segmentStart))
              .map(sub => ({
                ...sub,
                start: Math.max(sub.start, segmentStart),
                end: Math.min(sub.end, segmentEnd)
              }));

            dbg(`[ProcessingUtils] Filtered ${data.subtitles.length} subtitles to ${filteredSubtitles.length} for segment ${segmentStart}-${segmentEnd}`);
          }


          // Dispatch streaming-update event for timeline animations
          if (data.isStreaming) {
            window.dispatchEvent(new CustomEvent('streaming-update', {
              detail: {
                subtitles: filteredSubtitles,
                segment: segment,
                runId: options && options.runId ? options.runId : undefined
              }
            }));
          }

          if (onSubtitleUpdate) {
            onSubtitleUpdate(filteredSubtitles, data.isStreaming);
          }
        },
        onStatusUpdate: setStatus,
        onComplete: (result) => {
          // Check if this is a parallel processing result that needs special handling
          let finalSubtitles;
          if (result && result.isSegmentResult) {
            // This is from parallel processing - extract subtitles
            dbg('[ProcessingUtils] Received parallel processing segment result');
            finalSubtitles = result.subtitles;
          } else if (Array.isArray(result)) {
            // Direct subtitle array from single streaming
            finalSubtitles = result;
          } else {
            // Might be text or other format, try to handle it
            dbgw('[ProcessingUtils] Unexpected result format:', typeof result);
            finalSubtitles = [];
          }

          dbg('[ProcessingUtils] Streaming complete:', finalSubtitles.length, 'subtitles');

          // Normalize potential relative times to absolute BEFORE final filtering/clipping
          let filteredFinal = finalSubtitles;
          if (finalSubtitles && finalSubtitles.length > 0) {
            const segmentStart = segment.start;
            const segmentEnd = segment.end;
            const segDuration = segmentEnd - segmentStart;

            const maxEndRaw = Math.max(...finalSubtitles.map(s => s.end || 0));
            const looksRelative = maxEndRaw <= (segDuration + 1);
            const normalized = looksRelative
              ? finalSubtitles.map(sub => ({
                  ...sub,
                  start: (sub.start || 0) + segmentStart,
                  end: (sub.end || 0) + segmentStart
                }))
              : finalSubtitles;

            filteredFinal = normalized.filter(sub => (sub.start < segmentEnd && sub.end > segmentStart))
              .map(sub => ({
                ...sub,
                start: Math.max(sub.start, segmentStart),
                end: Math.min(sub.end, segmentEnd)
              }));

            dbg(`[ProcessingUtils] Final filter: ${finalSubtitles.length} subtitles to ${filteredFinal.length} for segment ${segmentStart}-${segmentEnd}`);
          }

          // Dispatch streaming-complete event for timeline animations
          window.dispatchEvent(new CustomEvent('streaming-complete', {
            detail: {
              subtitles: filteredFinal,
              segment: segment,
              runId: options && options.runId ? options.runId : undefined
            }
          }));

          resolve(filteredFinal);
        },
        onError: (error) => {
          console.error('[ProcessingUtils] Streaming error:', error);
          reject(error);
        }
      });

      // Prepare video metadata for segment processing
      // Using string format that was working before
      // FPS compatibility is now handled in the UI (VideoProcessingOptionsModal)
      const videoMetadata = {
        start_offset: `${Math.floor(segment.start)}s`,
        end_offset: `${Math.floor(segment.end)}s`,
        fps: fps
      };

      // Map media resolution to API enum value
      const mappedMediaResolution = mapMediaResolution(mediaResolution);

      // Base options common to both API paths
      const baseApiOptionsBase = {
        userProvidedSubtitles,
        modelId: model,
        mediaResolution: mappedMediaResolution,
        maxDurationPerRequest: options.maxDurationPerRequest,
        autoSplitSubtitles: autoSplitSubtitles,
        maxWordsPerSubtitle: maxWordsPerSubtitle,
        // propagate optional correlation id for downstream services
        ...(options && options.runId ? { runId: options.runId } : {})
      };

      // All-in on Files API by default; only use INLINE when explicitly forced
      const useInline = options.forceInline === true;
      const noOffsets = options.noOffsets === true;

      // Include segmentInfo except when we are INLINE with noOffsets (already clipped file)
      const baseApiOptions = (useInline && noOffsets)
        ? { ...baseApiOptionsBase }
        : {
            ...baseApiOptionsBase,
            segmentInfo: {
              start: segment.start,
              end: segment.end,
              duration: segment.end - segment.start
            }
          };

      const apiOptions = useInline
        ? { ...baseApiOptions, forceInline: true }
        : { ...baseApiOptions, ...(noOffsets ? {} : { videoMetadata }) };


      // Start streaming (Files API vs INLINE)
      import('../../services/gemini').then(({ streamGeminiApiWithFilesApi, streamGeminiApiInline }) => {
        const streamFn = useInline ? streamGeminiApiInline : streamGeminiApiWithFilesApi;
        streamFn(
          file,
          apiOptions,
          (chunk) => processor.processChunk(chunk),
          (finalText) => processor.complete(finalText),
          (error) => processor.error(error),
          (progress) => {
            // Handle parallel processing progress updates
            if (progress && progress.segmentProgress) {
              dbg('[ProcessingUtils] Parallel processing progress:', progress);
              // Dispatch progress event for UI updates
              window.dispatchEvent(new CustomEvent('parallel-processing-progress', {
                detail: progress
              }));
            }
          }
        );
      }).catch(reject);
    }).catch(reject);
  });
};


/**
 * Extract the selected segment locally and send inline to Gemini (no offsets)
 */
export const processSegmentWithInlineExtraction = async (file, segment, options, setStatus, t) => {
  try {
    const { model, userProvidedSubtitles } = options || {};
    setStatus({ message: t('processing.extractingSegment', 'Extracting selected segment locally...'), type: 'loading' });

    const { extractVideoSegmentLocally } = await import('../videoSegmenter');
    const segmentFile = await extractVideoSegmentLocally(file, segment.start, segment.end);

    setStatus({ message: t('processing.sendingToGemini', 'Sending extracted segment to Gemini...'), type: 'loading' });
    const { callGeminiApi } = await import('../../services/gemini');

    const rawSubtitles = await callGeminiApi(segmentFile, 'file-upload', {
      userProvidedSubtitles,
      modelId: model,
      segmentInfo: { start: segment.start, end: segment.end, duration: segment.end - segment.start },
      forceInline: true,
      ...(options && options.runId ? { runId: options.runId } : {})
    });

    let adjusted = Array.isArray(rawSubtitles) ? rawSubtitles : [];
    if (adjusted.length > 0) {
      const segDuration = segment.end - segment.start;
      const maxEnd = Math.max(...adjusted.map(s => s.end || 0));
      const looksRelative = maxEnd <= (segDuration + 1);
      if (looksRelative) {
        adjusted = adjusted.map(s => ({
          ...s,
          start: (s.start || 0) + segment.start,
          end: (s.end || 0) + segment.start
        }));
      }
    }

    return adjusted;
  } catch (error) {
    console.error('Error processing segment with inline extraction:', error);
    throw error;
  }
};
