/**
 * Parallel Streaming Coordinator for Gemini API
 * Manages multiple concurrent streaming requests and coordinates their responses
 */

import { streamGeminiContent } from './streamingService';
import { 
  splitSegmentForParallelProcessing, 
  mergeParallelSubtitles,
  ParallelProgressTracker 
} from '../../utils/parallelProcessingUtils';
import { autoSplitSubtitles } from '../../utils/subtitle/splitUtils';

/**
 * Coordinate parallel streaming requests for a video segment
 * @param {File} file - The media file (already uploaded to Files API)
 * @param {string} fileUri - The uploaded file URI from Files API
 * @param {Object} options - Generation options including maxDurationPerRequest
 * @param {Function} onChunk - Callback for each streaming chunk (aggregated from all parallel streams)
 * @param {Function} onComplete - Callback when all streams are complete
 * @param {Function} onError - Callback for errors
 * @param {Function} onProgress - Callback for progress updates
 */
export const coordinateParallelStreaming = async (
  file,
  fileUri,
  options = {},
  onChunk,
  onComplete,
  onError,
  onProgress
) => {
  const { 
    segmentInfo, 
    maxDurationPerRequest,
    userProvidedSubtitles,
    modelId,
    videoMetadata,
    mediaResolution,
    autoSplitSubtitles: autoSplitEnabled,
    maxWordsPerSubtitle
  } = options;

  // Check if we need to split the segment
  if (!segmentInfo || !maxDurationPerRequest) {
    // No parallel processing needed, use single stream
    console.log('[ParallelCoordinator] No parallel processing needed, using single stream');
    return streamGeminiContent(file, fileUri, options, onChunk, onComplete, onError);
  }

  const segment = {
    start: segmentInfo.start,
    end: segmentInfo.end
  };

  // Split the segment for parallel processing
  const subSegments = splitSegmentForParallelProcessing(segment, maxDurationPerRequest);

  if (subSegments.length === 1) {
    // No splitting needed, use single stream
    console.log('[ParallelCoordinator] Segment within max duration, using single stream');
    return streamGeminiContent(file, fileUri, options, onChunk, onComplete, onError);
  }

  console.log(`[ParallelCoordinator] Starting parallel processing with ${subSegments.length} segments`);

  // Initialize progress tracker
  const progressTracker = new ParallelProgressTracker(subSegments.length, onProgress);

  // Store results from each segment
  const segmentResults = new Array(subSegments.length);
  const segmentSubtitles = new Array(subSegments.length).fill([]);
  const segmentTexts = new Array(subSegments.length).fill('');
  let completedSegments = 0;
  let failedSegments = [];

  // Helper function to attempt streaming with retries for 503 errors
  const streamWithRetry = async (subSegment, index, retryCount = 0, maxRetries = 3) => {
    return new Promise((resolve, reject) => {
      const attemptNumber = retryCount + 1;
      
      if (retryCount > 0) {
        console.log(`[ParallelCoordinator] Retrying segment ${index + 1}/${subSegments.length} (attempt ${attemptNumber}/${maxRetries + 1})`);
      } else {
        console.log(`[ParallelCoordinator] Starting stream for segment ${index + 1}/${subSegments.length}: [${subSegment.start}s-${subSegment.end}s]`);
      }

      // Prepare options for this segment
      const segmentOptions = {
        ...options,
        segmentInfo: {
          start: subSegment.start,
          end: subSegment.end,
          duration: subSegment.end - subSegment.start
        },
        // Adjust video metadata for this specific segment
        videoMetadata: videoMetadata ? {
          ...videoMetadata,
          start_offset: `${Math.floor(subSegment.start)}s`,
          // Add 2 second buffer to end_offset to ensure Gemini processes the entire segment
          // Use ceiling + 1 to make sure we capture everything
          end_offset: `${Math.ceil(subSegment.end) + 2}s`
        } : undefined
      };

      // Start streaming for this segment with hallucination recovery support
      streamGeminiContent(
        file,
        fileUri,
        segmentOptions,
        // onChunk - collect subtitles from each segment
        (chunk) => {
          if (chunk.subtitles && chunk.subtitles.length > 0) {
            // CRITICAL FIX: Adjust subtitle timestamps to be absolute, not relative
            // When processing a segment starting at time X, Gemini might return:
            // 1. Absolute timestamps (already correct)
            // 2. Relative timestamps starting from 0
            // We detect relative timestamps when they're too small to be in the segment
            const segmentDuration = subSegment.end - subSegment.start;
            
            // Check the first subtitle to determine if adjustment is needed
            let needsAdjustment = false;
            if (chunk.subtitles.length > 0) {
              const firstSubtitle = chunk.subtitles[0];
              // If the first subtitle starts before half the segment start time, it's likely relative
              needsAdjustment = firstSubtitle.start < subSegment.start / 2;
              
              // Removed debug logging for specific segments
            }
            
            let adjustedSubtitles = chunk.subtitles.map((subtitle, subIdx) => {
              if (needsAdjustment) {
                // Add segment start to convert relative to absolute
                const adjusted = {
                  ...subtitle,
                  start: subtitle.start + subSegment.start,
                  end: subtitle.end + subSegment.start
                };
                
                // Removed debug logging
                
                return adjusted;
              }
              return subtitle;
            });
            
            // Apply auto-split if enabled
            if (autoSplitEnabled && maxWordsPerSubtitle > 0) {
              const beforeSplitCount = adjustedSubtitles.length;
              adjustedSubtitles = autoSplitSubtitles(adjustedSubtitles, maxWordsPerSubtitle);
              // PERFORMANCE: Only log significant auto-splits to reduce noise
              if (adjustedSubtitles.length > beforeSplitCount && (adjustedSubtitles.length - beforeSplitCount) > 5) {
                console.log(`[ParallelCoordinator] Auto-split applied to segment ${index + 1}: ${beforeSplitCount} -> ${adjustedSubtitles.length} subtitles`);
              }
            }
            
            segmentSubtitles[index] = adjustedSubtitles;
            segmentTexts[index] = chunk.accumulatedText || '';
            
            // PERFORMANCE: Reduced logging frequency for better performance with long videos
            if (chunk.chunkCount % 50 === 0) {
              console.log(`[ParallelCoordinator] Seg ${index + 1}: ${adjustedSubtitles.length} subtitles`);
            }

            // Update progress for this segment
            const progress = Math.min(90, (chunk.chunkCount || 1) * 10); // Estimate progress
            progressTracker.updateSegmentProgress(index, progress);

            // Aggregate and send combined results
            const segmentsWithSubtitles = segmentSubtitles
              .map((subs, i) => ({ segment: subSegments[i], subtitles: subs }))
              .filter(result => result.subtitles.length > 0);
            
            // Removed verbose pre-merge logging
            
            const aggregatedSubtitles = mergeParallelSubtitles(segmentsWithSubtitles);

            // Send aggregated chunk update
            onChunk({
              text: segmentTexts.join('\n'),
              accumulatedText: segmentTexts.join('\n'),
              subtitles: aggregatedSubtitles,
              chunkCount: chunk.chunkCount,
              isComplete: false,
              parallelInfo: {
                segmentIndex: index,
                totalSegments: subSegments.length,
                segmentProgress: progressTracker.segmentProgress
              }
            });
          }
        },
        // onComplete for this segment
        (finalText) => {
          console.log(`[ParallelCoordinator] Seg ${index + 1} done: ${segmentSubtitles[index]?.length || 0} subtitles`);
          
          // Final adjustment check - ensure we haven't already adjusted these
          // The adjustment should have been done during streaming
          const adjustedSubtitles = segmentSubtitles[index] || [];
          
          // Store final results for this segment with adjusted timestamps
          segmentResults[index] = {
            segment: subSegment,
            subtitles: adjustedSubtitles,
            text: finalText
          };

          progressTracker.markSegmentComplete(index);
          completedSegments++;

          resolve({
            segmentIndex: index,
            subtitles: segmentSubtitles[index],
            text: finalText
          });
        },
        // onError for this segment
        async (error) => {
          // Check for file permission errors that should be propagated up immediately
          if (error && error.message && 
              ((error.message.includes('403') && 
               (error.message.includes('PERMISSION_DENIED') || 
                error.message.includes('You do not have permission to access the File') ||
                error.message.includes('it may not exist'))) ||
              error.message.includes('FILE_URI_EXPIRED'))) {
            console.error(`[ParallelCoordinator] File URI expired for segment ${index + 1}, propagating error up`);
            // Don't retry, propagate the error up to trigger re-upload
            reject(error);
            return;
          }
          
          // Check if this is a 503 error (overload) or 429 error (rate limit)
          const is503Error = error && error.message && (
            error.message.includes('503') ||
            error.message.includes('overloaded') ||
            error.message.includes('UNAVAILABLE')
          );
          
          const is429Error = error && error.message && (
            error.message.includes('429') ||
            error.message.includes('RESOURCE_EXHAUSTED') ||
            error.message.includes('quota') ||
            error.message.includes('rate limit')
          );
          
          const shouldRetry = (is503Error || is429Error) && retryCount < maxRetries;
          
          if (shouldRetry) {
            const errorType = is429Error ? '429 (rate limit)' : '503 (overload)';
            // Progressive retry delays: 5, 10, 15, 20, 25 seconds
            const retryDelays = [5, 10, 15, 20, 25];
            const retryDelaySeconds = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
            console.warn(`[ParallelCoordinator] Segment ${index + 1}/${subSegments.length} got ${errorType} error, retrying in ${retryDelaySeconds} seconds (attempt ${retryCount + 1}/${maxRetries})...`);
            
            // Wait with progressive delay
            await new Promise(wait => setTimeout(wait, 1000 * retryDelaySeconds));
            
            // Retry the segment
            try {
              const result = await streamWithRetry(subSegment, index, retryCount + 1, maxRetries);
              resolve(result);
            } catch (retryError) {
              // If retry also fails, handle as final error
              console.error(`[ParallelCoordinator] Error in segment ${index + 1}/${subSegments.length} after ${attemptNumber} attempts:`, retryError);
              
              progressTracker.markSegmentFailed(index, retryError);
              failedSegments.push({ index, error: retryError });

              segmentResults[index] = {
                segment: subSegment,
                error: retryError,
                subtitles: [],
                text: ''
              };

              resolve({
                segmentIndex: index,
                error: retryError
              });
            }
          } else {
            // Not a 503 error or max retries reached
            console.error(`[ParallelCoordinator] Error in segment ${index + 1}/${subSegments.length}:`, error);
            
            progressTracker.markSegmentFailed(index, error);
            failedSegments.push({ index, error });

            // Don't reject immediately - allow other segments to complete
            // But mark this segment as failed
            segmentResults[index] = {
              segment: subSegment,
              error: error,
              subtitles: [],
              text: ''
            };

            resolve({
              segmentIndex: index,
              error: error
            });
          }
        }
      );
    });
  };

  // Create a promise for each segment
  const segmentPromises = subSegments.map((subSegment, index) => {
    return streamWithRetry(subSegment, index, 0, 5); // Increased from 3 to 5 retry attempts
  });

  try {
    // Wait for all segments to complete (or fail)
    const results = await Promise.allSettled(segmentPromises);
    
    // Check for file permission errors first - these should trigger immediate re-upload
    const filePermissionError = results.find(r => {
      if (r.status === 'rejected' && r.reason && r.reason.message) {
        return ((r.reason.message.includes('403') && 
                (r.reason.message.includes('PERMISSION_DENIED') || 
                 r.reason.message.includes('You do not have permission to access the File') ||
                 r.reason.message.includes('it may not exist'))) ||
               r.reason.message.includes('FILE_URI_EXPIRED'));
      }
      return false;
    });
    
    if (filePermissionError) {
      console.error('[ParallelCoordinator] File permission error detected, propagating to trigger re-upload');
      onError(filePermissionError.reason);
      return;
    }

    console.log(`[ParallelCoordinator] All segments processed. Success: ${completedSegments}, Failed: ${failedSegments.length}`);
    
    // Log detailed segment results for debugging
    console.log('[ParallelCoordinator] Detailed segment results:');
    segmentResults.forEach((result, idx) => {
      if (result) {
        console.log(`  Segment ${idx + 1}: [${result.segment.start}-${result.segment.end}s] - `, 
          result.error ? `FAILED: ${result.error.message}` : `SUCCESS: ${result.subtitles?.length || 0} subtitles`);
      } else {
        console.log(`  Segment ${idx + 1}: NOT PROCESSED`);
      }
    });

    // Check if we have at least some successful segments
    const successfulResults = segmentResults.filter(r => r && !r.error && r.subtitles);

    if (successfulResults.length === 0) {
      // All segments failed
      const error = new Error(`All ${subSegments.length} parallel segments failed to process`);
      onError(error);
      return;
    }

    // Log before merging to understand the input
    console.log('[ParallelCoordinator] Before final merge:');
    const totalInputSubtitles = successfulResults.reduce((sum, r) => sum + (r.subtitles?.length || 0), 0);
    console.log(`  Total input subtitles: ${totalInputSubtitles}`);
    successfulResults.forEach((result, idx) => {
      if (result.subtitles && result.subtitles.length > 0) {
        const firstSub = result.subtitles[0];
        const lastSub = result.subtitles[result.subtitles.length - 1];
        console.log(`  Segment ${idx + 1}: ${result.subtitles.length} subs, range: ${firstSub.start.toFixed(1)}-${lastSub.end.toFixed(1)}s`);
      }
    });
    
    // Merge all successful subtitles
    let finalSubtitles = mergeParallelSubtitles(successfulResults);
    console.log(`[ParallelCoordinator] After merge: ${finalSubtitles.length} subtitles (was ${totalInputSubtitles})`);
    
    // Apply final auto-split if enabled (in case merging combined any subtitles)
    if (autoSplitEnabled && maxWordsPerSubtitle > 0) {
      const beforeSplitCount = finalSubtitles.length;
      finalSubtitles = autoSplitSubtitles(finalSubtitles, maxWordsPerSubtitle);
      if (finalSubtitles.length > beforeSplitCount) {
        console.log(`[ParallelCoordinator] Final auto-split applied: ${beforeSplitCount} -> ${finalSubtitles.length} subtitles`);
      }
    }
    
    const finalText = successfulResults
      .map(r => r.text)
      .filter(t => t)
      .join('\n');

    // If some segments failed, notify but still return partial results
    if (failedSegments.length > 0) {
      console.warn(`[ParallelCoordinator] ${failedSegments.length} segments failed, returning partial results`);
      
      // Dispatch warning event
      window.dispatchEvent(new CustomEvent('parallel-processing-partial', {
        detail: {
          totalSegments: subSegments.length,
          failedSegments: failedSegments,
          successfulSegments: successfulResults.length
        }
      }));
    }

    // CRITICAL FIX: Return subtitles as an object with metadata about the segment
    // This allows the caller to know this is a segment result that needs merging with existing subtitles
    // For backward compatibility, check if this is segment processing
    if (options.segmentInfo) {
      // Return as segment result that needs merging
      onComplete({
        subtitles: finalSubtitles,
        isSegmentResult: true,
        segment: options.segmentInfo,
        text: finalText
      });
    } else {
      // Non-segment processing - return subtitles directly for backward compatibility
      onComplete(finalSubtitles);
    }

  } catch (error) {
    console.error('[ParallelCoordinator] Unexpected error in parallel processing:', error);
    onError(error);
  }
};

/**
 * Check if parallel processing should be used
 * @param {Object} segment - The segment to process
 * @param {number} maxDurationPerRequest - Maximum duration per request
 * @returns {boolean} Whether to use parallel processing
 */
export const shouldUseParallelProcessing = (segment, maxDurationPerRequest) => {
  if (!segment || !maxDurationPerRequest) return false;
  
  const duration = segment.end - segment.start;
  return duration > maxDurationPerRequest;
};

/**
 * Estimate time savings from parallel processing
 * @param {number} totalDuration - Total duration in seconds
 * @param {number} maxDurationPerRequest - Maximum duration per request in seconds
 * @param {number} avgProcessingTimePerMinute - Average processing time per minute of video
 * @returns {Object} Time estimation
 */
export const estimateParallelTimeSavings = (
  totalDuration, 
  maxDurationPerRequest, 
  avgProcessingTimePerMinute = 10 // Default: 10 seconds per minute of video
) => {
  const numSegments = Math.ceil(totalDuration / maxDurationPerRequest);
  
  // Sequential time estimate
  const sequentialTime = (totalDuration / 60) * avgProcessingTimePerMinute;
  
  // Parallel time estimate (assuming perfect parallelization)
  // In reality, there's some overhead, so add 20% overhead
  const parallelTime = ((totalDuration / numSegments) / 60) * avgProcessingTimePerMinute * 1.2;
  
  const timeSaved = Math.max(0, sequentialTime - parallelTime);
  const speedup = sequentialTime / parallelTime;

  return {
    numSegments,
    sequentialTime: Math.round(sequentialTime),
    parallelTime: Math.round(parallelTime),
    timeSaved: Math.round(timeSaved),
    speedup: speedup.toFixed(2)
  };
};
