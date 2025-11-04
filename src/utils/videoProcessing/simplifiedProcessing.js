/**
 * Simplified video processing using Gemini Files API
 * This replaces the complex segment-based processing with a single API call
 */

import { callGeminiApiWithFilesApi, callGeminiApi } from '../../services/geminiService';
import { getVideoProcessingFps } from '../../services/configService';
import { analyzeVideoAndWaitForUserChoice } from './analysisUtils';
import { getCacheIdForMedia } from './cacheUtils';
import { setCurrentCacheId as setRulesCacheId } from '../transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../userSubtitlesStore';

/**
 * Process a video file using the simplified Files API approach
 * @param {File} mediaFile - The media file to process
 * @param {Function} onStatusUpdate - Callback for status updates
 * @param {Function} t - Translation function
 * @param {Object} options - Processing options
 * @returns {Promise<Array>} - Array of subtitle objects
 */
export const processVideoWithFilesApi = async (mediaFile, onStatusUpdate, t, options = {}) => {
  const { userProvidedSubtitles, customVideoMetadata } = options;
  const isAudio = mediaFile.type.startsWith('audio/');

  try {
    // Set cache ID for the current media
    const cacheId = getCacheIdForMedia(mediaFile);
    if (cacheId) {
      setRulesCacheId(cacheId);
      setSubtitlesCacheId(cacheId);
    }

    // Video analysis is always enabled
    const useVideoAnalysis = true;
    const skipAnalysis = localStorage.getItem('skip_video_analysis') === 'true';

    // Prepare video metadata options
    let videoMetadata = customVideoMetadata || {};
    // Preserve flip flags from cropSettings so renderer can apply them
    if (options?.cropSettings?.flipX !== undefined) videoMetadata.flipX = Boolean(options.cropSettings.flipX);
    if (options?.cropSettings?.flipY !== undefined) videoMetadata.flipY = Boolean(options.cropSettings.flipY);

    // Apply default video processing settings if not provided
    if (!customVideoMetadata) {
      // Get FPS setting via config service (respect presence flag for backwards-compat)
      const hasCustomFps = !!localStorage.getItem('video_processing_fps');
      if (hasCustomFps && !isAudio) {
        // FPS compatibility is now handled in the UI (VideoProcessingOptionsModal)
        videoMetadata.fps = getVideoProcessingFps();
      }

      // Get video clipping settings if available
      const startOffset = localStorage.getItem('video_start_offset');
      const endOffset = localStorage.getItem('video_end_offset');
      if (startOffset && !isAudio) {
        videoMetadata.start_offset = `${startOffset}s`;
      }
      if (endOffset && !isAudio) {
        videoMetadata.end_offset = `${endOffset}s`;
      }
    }

    // Perform video analysis if enabled and not skipped
    if (useVideoAnalysis && !skipAnalysis && !isAudio && !userProvidedSubtitles) {
      onStatusUpdate({
        message: t('output.analyzingVideo', 'Analyzing video content...'),
        type: 'loading'
      });

      try {
        await analyzeVideoAndWaitForUserChoice(mediaFile, onStatusUpdate, t);
      } catch (analysisError) {
        console.error('Error analyzing video:', analysisError);
        onStatusUpdate({
          message: t('output.analysisError', 'Video analysis failed, proceeding with default settings.'),
          type: 'warning'
        });
      }
    }

    // Update status for processing
    if (userProvidedSubtitles) {
      onStatusUpdate({
        message: t('output.processingWithCustomSubtitles', 'Processing video with your provided subtitles...'),
        type: 'loading'
      });
    } else {
      onStatusUpdate({
        message: isAudio 
          ? t('output.processingAudio', 'Processing audio file...')
          : t('output.processingVideo', 'Processing video...'),
        type: 'loading'
      });
    }

    // Process the media file
    let subtitles;
    if (options.forceInline || options.inlineExtraction) {
      // Inline path (no offsets). Non-streaming here to maintain simplified flow semantics.
      subtitles = await callGeminiApi(mediaFile, 'file-upload', {
        userProvidedSubtitles,
        forceInline: true,
        // Ensure no offsets are sent in inline mode
        videoMetadata: undefined,
        ...(options && options.runId ? { runId: options.runId } : {})
      });
    } else {
      // Files API path (legacy simplified)
      subtitles = await callGeminiApiWithFilesApi(mediaFile, {
        userProvidedSubtitles,
        videoMetadata: Object.keys(videoMetadata).length > 0 ? videoMetadata : undefined,
        ...(options && options.runId ? { runId: options.runId } : {})
      });
    }

    onStatusUpdate({
      message: t('output.processingComplete', 'Processing complete!'),
      type: 'success'
    });

    return subtitles;

  } catch (error) {
    console.error('Error processing media with Files API:', error);
    
    // Handle specific error types
    if (error.message && (
      error.message.includes('API error:') ||
      error.message.includes('Gemini') ||
      error.message.includes('503') ||
      error.message.includes('Service Unavailable') ||
      error.message.includes('overloaded') ||
      error.message.includes('UNAVAILABLE') ||
      error.message.includes('quota') ||
      error.message.includes('RESOURCE_EXHAUSTED') ||
      error.isOverloaded
    )) {
      // This is a Gemini API error - re-throw it
      throw error;
    }

    // For other errors, provide a more user-friendly message
    throw new Error(t('errors.processingFailed', 'Failed to process media file: {{message}}', { 
      message: error.message 
    }));
  }
};

/**
 * Check if the simplified processing should be used
 * @param {File} mediaFile - The media file
 * @returns {boolean} - True if should use simplified processing
 */
export const shouldUseSimplifiedProcessing = (mediaFile) => {
  // Check if user has enabled the new processing method
  const useSimplifiedProcessing = localStorage.getItem('use_simplified_processing') === 'true';
  
  // For now, we'll make this opt-in to ensure compatibility
  // Later this can become the default
  return useSimplifiedProcessing;
};

/**
 * Get estimated video duration for processing decisions
 * @param {File} mediaFile - The media file
 * @returns {Promise<number>} - Duration in seconds
 */
export const getEstimatedDuration = async (mediaFile) => {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    video.onloadedmetadata = () => {
      resolve(video.duration || 0);
    };
    
    video.onerror = () => {
      resolve(0); // Return 0 if we can't determine duration
    };
    
    // Set timeout to avoid hanging
    setTimeout(() => resolve(0), 5000);
    
    video.src = URL.createObjectURL(mediaFile);
  });
};

/**
 * Create video metadata configuration for different use cases
 * @param {Object} options - Configuration options
 * @returns {Object} - Video metadata object
 */
export const createVideoMetadata = (options = {}) => {
  const {
    fps = null,
    startTime = null,
    endTime = null,
    resolution = null
  } = options;

  const metadata = {};

  if (fps !== null) {
    // FPS compatibility is now handled in the UI (VideoProcessingOptionsModal)
    metadata.fps = fps;
  }

  if (startTime !== null) {
    metadata.start_offset = `${startTime}s`;
  }

  if (endTime !== null) {
    metadata.end_offset = `${endTime}s`;
  }

  // Note: Resolution is handled differently in Files API
  // It's controlled by the mediaResolution parameter in the request
  if (resolution) {
    console.log(`Video resolution preference: ${resolution} (will be applied via mediaResolution parameter)`);
  }

  // Propagate flip flags if provided either in options or nested cropSettings.
  // This ensures any consumer (Files API, renderer or server) receives explicit flip metadata.
  if (options) {
    // Top-level flags
    if (typeof options.flipX !== 'undefined') {
      metadata.flipX = Boolean(options.flipX);
    }
    if (typeof options.flipY !== 'undefined') {
      metadata.flipY = Boolean(options.flipY);
    }

    // Nested crop settings (common UI shape)
    const cs = options.cropSettings ?? options.crop ?? null;
    if (cs && typeof cs === 'object') {
      if (typeof cs.flipX !== 'undefined') metadata.flipX = Boolean(cs.flipX);
      if (typeof cs.flipY !== 'undefined') metadata.flipY = Boolean(cs.flipY);
    }
  }

  return metadata;
};

/**
 * Wrapper function that chooses between simplified and legacy processing
 * @param {File} mediaFile - The media file
 * @param {Function} onStatusUpdate - Callback for status updates
 * @param {Function} t - Translation function
 * @param {Object} options - Processing options
 * @returns {Promise<Array>} - Array of subtitle objects
 */
export const processMediaFile = async (mediaFile, onStatusUpdate, t, options = {}) => {
  if (shouldUseSimplifiedProcessing(mediaFile)) {
    console.log('[VideoProcessing] Using simplified Files API processing');
    return await processVideoWithFilesApi(mediaFile, onStatusUpdate, t, options);
  } else {
    console.log('[VideoProcessing] Legacy processing is no longer available. Using simplified processing instead.');
    onStatusUpdate({
      message: t('output.legacyDeprecated', 'Legacy processing is deprecated. Using simplified processing for better performance.'),
      type: 'warning'
    });
    return await processVideoWithFilesApi(mediaFile, onStatusUpdate, t, options);
  }
};
