/**
 * Streaming orchestration for the Gemini API.
 * Selects between Files-API and inline streaming, routes segments, and
 * recovers from 403 (expired/deleted file) errors by re-uploading.
 * Split out of core.js for maintainability.
 */

import { resolveGeminiFileCache } from './fileCache';
import { uploadFileToGemini } from './filesApi';
import { streamGeminiContent, isStreamingSupported } from './streamingService';
import { coordinateParallelStreaming, shouldUseParallelProcessing, coordinateParallelInlineStreaming } from './parallelStreamingCoordinator';
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeMediaModelId } from '../../config/geminiModels';

/**
 * Stream content generation using Files API
 * @param {File} file - The media file
 * @param {Object} options - Generation options
 * @param {Function} onChunk - Callback for streaming chunks
 * @param {Function} onComplete - Callback when complete
 * @param {Function} onError - Callback for errors
 * @returns {Promise<void>}
 */
export const streamGeminiApiWithFilesApi = async (file, options = {}, onChunk, onComplete, onError, onProgress, retryCount = 0) => {
    const { userProvidedSubtitles, modelId, videoMetadata, mediaResolution, maxDurationPerRequest } = options;
    const MODEL = normalizeMediaModelId(
        modelId || localStorage.getItem('gemini_model'),
        DEFAULT_TRANSCRIPTION_MODEL_ID
    );

    console.log(`[GeminiAPI] Using streaming Files API with model: ${MODEL}`);

    // Check if streaming is supported
    if (!isStreamingSupported(MODEL)) {
        console.warn('[GeminiAPI] Streaming not supported for model:', MODEL, '- falling back to regular API');
        try {
            const { callGeminiApiWithFilesApi } = await import('./core');
            const result = await callGeminiApiWithFilesApi(file, options);
            onComplete(result);
        } catch (error) {
            onError(error);
        }
        return;
    }

    try {
        // Check if we already have an uploaded file URI for this file
        // Use different caching strategies for uploaded vs downloaded videos
        let fileKey;
        const __cache = await resolveGeminiFileCache(file, '[GeminiAPI]');
        fileKey = __cache.fileKey;
        let uploadedFile = __cache.uploadedFile;
        let shouldUpload = !uploadedFile || !uploadedFile.uri || retryCount > 0;

        if (uploadedFile && uploadedFile.uri && retryCount === 0) {
            console.log('Reusing existing uploaded file URI:', uploadedFile.uri);
            // Dispatch event to update status if needed
            window.dispatchEvent(new CustomEvent('gemini-file-reused', {
                detail: { fileName: file.name, uri: uploadedFile.uri }
            }));
        }

        if (shouldUpload) {
            // Upload file to Gemini Files API
            console.log(retryCount > 0 ? 'Re-uploading expired file to Gemini Files API...' : 'Uploading file to Gemini Files API...');
            // Dispatch event to update status if needed
            window.dispatchEvent(new CustomEvent('gemini-file-uploading', {
                detail: { fileName: file.name, isRetry: retryCount > 0 }
            }));

            uploadedFile = await uploadFileToGemini(file, `${file.name}_${Date.now()}` , { runId: options && options.runId ? options.runId : undefined });
            console.log('File uploaded successfully:', uploadedFile.uri);

            // Cache the uploaded file info for reuse
            localStorage.setItem(fileKey, JSON.stringify(uploadedFile));

            // Dispatch event to update status
            window.dispatchEvent(new CustomEvent('gemini-file-uploaded', {
                detail: { fileName: file.name, uri: uploadedFile.uri, isRetry: retryCount > 0 }
            }));
        }

        // Start streaming with error handling wrapper
        const streamWithErrorHandling = async () => {
            // Check if we should use parallel processing
            const useParallel = shouldUseParallelProcessing(
                options.segmentInfo ? { start: options.segmentInfo.start, end: options.segmentInfo.end } : null,
                maxDurationPerRequest
            );

            const streamFunction = useParallel ? coordinateParallelStreaming : streamGeminiContent;

            console.log(`[GeminiAPI] Using ${useParallel ? 'parallel' : 'single'} streaming`);

            await streamFunction(
                file,
                uploadedFile.uri,
                {
                    userProvidedSubtitles,
                    modelId,
                    videoMetadata,
                    mediaResolution,
                    segmentInfo: options.segmentInfo,
                    maxDurationPerRequest,
                    segmentProcessingDelay: options.segmentProcessingDelay,
                    autoSplitSubtitles: options.autoSplitSubtitles,
                    maxWordsPerSubtitle: options.maxWordsPerSubtitle,
                    t: options.t
                },
                onChunk,
                onComplete,
                async (error) => {
                    // Check if this is a file permission error (expired or deleted file)
                    if (error && error.message &&
                        ((error.message.includes('403') &&
                         (error.message.includes('PERMISSION_DENIED') ||
                          error.message.includes('You do not have permission to access the File') ||
                          error.message.includes('it may not exist'))) ||
                        error.message.includes('FILE_URI_EXPIRED'))) {

                        console.warn('[GeminiAPI] Cached file URI is no longer valid, clearing cache and retrying...');

                        // Clear the invalid cached URI
                        localStorage.removeItem(fileKey);

                        // Retry only once to avoid infinite loops
                        if (retryCount === 0) {
                            console.log('[GeminiAPI] Retrying with fresh file upload...');
                            // Retry the entire operation with fresh upload
                            await streamGeminiApiWithFilesApi(
                                file,
                                options,
                                onChunk,
                                onComplete,
                                onError,
                                onProgress,
                                retryCount + 1
                            );
                        } else {
                            console.error('[GeminiAPI] Failed after retry, giving up');
                            onError(error);
                        }
                    } else {
                        // For other errors, just pass them through
                        onError(error);
                    }
                }
            );
        };

        await streamWithErrorHandling();

    } catch (error) {
        console.error('Error in streaming Files API:', error);
        onError(error);
    }
};

/**
 * Stream content generation using INLINE data (no Files API, no video_metadata)
 */
export const streamGeminiApiInline = async (file, options = {}, onChunk, onComplete, onError, onProgress) => {
  const { modelId, maxDurationPerRequest } = options;
  const MODEL = normalizeMediaModelId(
    modelId || localStorage.getItem('gemini_model'),
    DEFAULT_TRANSCRIPTION_MODEL_ID
  );

  console.log(`[GeminiAPI] Using streaming INLINE with model: ${MODEL}`);

  // Check if streaming is supported
  if (!isStreamingSupported(MODEL)) {
    console.warn('[GeminiAPI] Streaming not supported for model:', MODEL, '- falling back to regular inline API');
    try {
      const { callGeminiApi } = await import('./core');
      const result = await callGeminiApi(file, 'file-upload', { ...options, forceInline: true });
      onComplete(result);
    } catch (error) {
      onError(error);
    }
    return;
  }

  // Prepare sanitized options: ensure no videoMetadata is sent for inline
  const { videoMetadata, ...optionsWithoutVideoMetadata } = options;
  const inlineOptions = { ...optionsWithoutVideoMetadata, forceInline: true };

  // Check if we should use parallel processing
  const useParallel = shouldUseParallelProcessing(
    inlineOptions.segmentInfo ? { start: inlineOptions.segmentInfo.start, end: inlineOptions.segmentInfo.end } : null,
    maxDurationPerRequest
  );

  console.log(`[GeminiAPI] Using ${useParallel ? 'parallel INLINE' : 'single INLINE'} streaming`);

  try {
    if (useParallel) {
      // Ensure t and segmentProcessingDelay are available in inlineOptions
      const parallelInlineOptions = {
        ...inlineOptions,
        t: options.t,
        segmentProcessingDelay: options.segmentProcessingDelay
      };
      await coordinateParallelInlineStreaming(
        file,
        null,
        parallelInlineOptions,
        onChunk,
        onComplete,
        onError,
        onProgress
      );
    } else {
      // For non-parallel INLINE with a segment, prefer server clipping when server is available; otherwise Files API offsets
      if (inlineOptions.segmentInfo) {
        const { start, end } = inlineOptions.segmentInfo;
        const isAudio = file.type.startsWith('audio/');

        // Try server-side ffmpeg splitting for both audio and video
        try {
          const { probeServerAvailability } = await import('../../utils/serverEnv');
          const hasServer = await probeServerAvailability();
          if (hasServer) {
            try {
              const { extractVideoSegmentLocally } = await import('../../utils/videoSegmenter');
              const clipped = await extractVideoSegmentLocally(file, start, end, { runId: inlineOptions && inlineOptions.runId ? inlineOptions.runId : undefined });
              const INLINE_LARGE_SEGMENT_THRESHOLD_BYTES = 20 * 1024 * 1024; // 20MB
              if (clipped && clipped.size > INLINE_LARGE_SEGMENT_THRESHOLD_BYTES) {
                await streamGeminiApiWithFilesApi(
                  clipped,
                  { ...inlineOptions, videoMetadata: undefined },
                  onChunk,
                  onComplete,
                  onError,
                  onProgress
                );
                return;
              }
              await streamGeminiContent(clipped, null, inlineOptions, onChunk, onComplete, onError);
              return;
            } catch (e) {
              console.warn('[GeminiAPI] Inline single-stream: server clipping failed, using Files API offsets', e);
            }
          }
        } catch {}

        // Default: Files API offsets path (Vercel version or server-clip failed)
        const filesApiOptions = {
          ...inlineOptions,
          forceInline: undefined
        };

        // Only add video metadata for video files, not audio files
        if (!isAudio) {
          filesApiOptions.videoMetadata = {
            start_offset: `${Math.floor(start)}s`,
            end_offset: `${Math.ceil(end)}s`
          };
        }

        await streamGeminiApiWithFilesApi(
          file,
          filesApiOptions,
          onChunk,
          onComplete,
          onError,
          onProgress
        );
        return;
      }
      // If no specific segment, fall back to inline full-source streaming (rare)
      await streamGeminiContent(file, null, inlineOptions, onChunk, onComplete, onError);
    }
  } catch (err) {
    console.error('[GeminiAPI] Error in inline streaming:', err);
    onError(err);
  }
};
