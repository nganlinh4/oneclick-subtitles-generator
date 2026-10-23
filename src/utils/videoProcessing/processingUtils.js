import { projectClipSubtitles } from './segmentTimestamps';
import { isNativeMediaDescriptor } from '../../platform/mediaService';
import { bindGeminiTranscriptionDeliveries } from '../../services/gemini/transcriptionDelivery';
import { shouldSplitGeneratedSubtitles } from '../../services/gemini/promptManagement';

/**
 * Segment streaming for native Gemini transcription (used by GeminiAdapter).
 */

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
  if (!isNativeMediaDescriptor(file)) {
    throw new Error('Select the media again before starting native Gemini transcription.');
  }

  return new Promise((resolve, reject) => {
    const { fps, mediaResolution, model, userProvidedSubtitles, autoSplitSubtitles, maxWordsPerSubtitle } = options;

    let providerResult = null;
    let providerSettled = false;
    let processedResult = null;
    let processorSettled = false;
    const resolveWhenAuthoritative = () => {
      if (!providerSettled || !processorSettled) return;
      resolve(bindGeminiTranscriptionDeliveries(processedResult, providerResult));
    };

    // Import streaming processor
     import('../../utils/subtitle/realtimeProcessor').then(({ createRealtimeProcessor }) => {
       // Create realtime processor with auto-split options from the modal
       // Convert to boolean properly - the value comes as a boolean from the modal
       const processor = createRealtimeProcessor({
         autoSplitEnabled: shouldSplitGeneratedSubtitles(options),
         maxWordsPerSubtitle: parseInt(maxWordsPerSubtitle) || 8,
         t, // Pass translation function for i18n support
         onSubtitleUpdate: (data) => {
          const filteredSubtitles = projectClipSubtitles(data.subtitles, segment);

          // Dispatch streaming-update event for timeline animations
          if (data.isStreaming) {
            // Use the actual sub-segment if available (from parallel processing),
            // otherwise use the provided segment (for single segment processing)
            const eventSegment = data.parallelInfo?.actualSegment || segment;
            window.dispatchEvent(new CustomEvent('streaming-update', {
              detail: {
                subtitles: filteredSubtitles,
                segment: eventSegment,
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
            finalSubtitles = result.subtitles;
          } else if (Array.isArray(result)) {
            // Direct subtitle array from single streaming
            finalSubtitles = result;
          } else {
            // Might be text or other format, try to handle it
            finalSubtitles = [];
          }


          const filteredFinal = projectClipSubtitles(finalSubtitles, segment);
            processedResult = filteredFinal;
            processorSettled = true;
            resolveWhenAuthoritative();
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
        audioOnly: options.audioOnly === true,
        videoFps: fps,
        userProvidedSubtitles,
        modelId: model,
        mediaResolution: mappedMediaResolution,
        maxDurationPerRequest: options.maxDurationPerRequest,
        segmentProcessingDelay: options.segmentProcessingDelay,
        autoSplitSubtitles: autoSplitSubtitles,
        maxWordsPerSubtitle: maxWordsPerSubtitle,
        promptContext: options.promptContext,
        autoRunContext: options.autoRunContext,
        signal: options.signal,
        // propagate translation function and optional correlation id for downstream services
        ...(t ? { t } : {}),
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

      let finalApiOptions = useInline
        ? { ...baseApiOptions, forceInline: true }
        : { ...baseApiOptions, ...(noOffsets ? {} : { videoMetadata }) };

      // Fix: For audio files, never include video metadata - it causes 500 errors
      if (file.type.startsWith('audio/')) {
        // Remove video metadata for audio files - it causes 500 errors
        delete finalApiOptions.videoMetadata;
        // Also ensure we're using the correct options for audio
        finalApiOptions = { ...finalApiOptions, forceInline: true };
      }


      // Start streaming (Files API vs INLINE)
      import('../../services/gemini').then(({ streamGeminiApiWithFilesApi, streamGeminiApiInline }) => {
        const streamFn = useInline ? streamGeminiApiInline : streamGeminiApiWithFilesApi;
        return streamFn(
          file,
          finalApiOptions,
          (chunk) => processor.processChunk(chunk),
          (finalText) => processor.complete(finalText),
          (error) => processor.error(error)
        );
      }).then((result) => {
        providerResult = result;
        providerSettled = true;
        resolveWhenAuthoritative();
      }).catch(reject);
    }).catch(reject);
  });
};

