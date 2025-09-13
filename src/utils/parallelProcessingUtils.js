/**
 * Utility functions for parallel video processing
 */

// Debug logging gate (enable by setting localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Split a segment into multiple sub-segments for parallel processing
 * @param {Object} segment - The original segment { start: number, end: number } in seconds
 * @param {number} maxDurationPerRequest - Maximum duration per request in seconds
 * @returns {Array} Array of sub-segments for parallel processing
 */
export const splitSegmentForParallelProcessing = (segment, maxDurationPerRequest) => {
  if (!segment || !maxDurationPerRequest) {
    throw new Error('Invalid input: segment and maxDurationPerRequest are required');
  }

  const { start, end } = segment;
  const totalDuration = end - start;

  // If the segment is within the max duration, no need to split
  if (totalDuration <= maxDurationPerRequest) {
    return [{
      ...segment,
      index: 0,
      isParallel: false
    }];
  }

  // Calculate the number of sub-segments needed
  const numSegments = Math.ceil(totalDuration / maxDurationPerRequest);

  // Calculate the optimal duration per segment (evenly distribute)
  const optimalDuration = totalDuration / numSegments;

  const subSegments = [];
  for (let i = 0; i < numSegments; i++) {
    const segmentStart = start + (i * optimalDuration);
    const segmentEnd = i === numSegments - 1
      ? end // Ensure last segment goes exactly to the end
      : start + ((i + 1) * optimalDuration);

    subSegments.push({
      start: segmentStart,
      end: segmentEnd,
      index: i,
      totalSegments: numSegments,
      isParallel: true,
      originalSegment: segment
    });
  }

  dbg(`[ParallelProcessing] Split segment [${start}s-${end}s] (${totalDuration}s) into ${numSegments} sub-segments:`, subSegments);

  return subSegments;
};

/**
 * Merge subtitles from multiple parallel segments
 * @param {Array} segmentResults - Array of { segment: Object, subtitles: Array }
 * @returns {Array} Merged and sorted subtitles
 */
export const mergeParallelSubtitles = (segmentResults) => {
  if (!segmentResults || !Array.isArray(segmentResults)) {
    return [];
  }

  // PERFORMANCE: Reduced logging - only log first merge and final merge
  const isFirstOrFinal = segmentResults.some(r => r.subtitles?.length > 50);
  if (isFirstOrFinal) {
    dbg(`[MergeParallelSubtitles] Starting merge of ${segmentResults.length} segments`);
  }

  // Collect all subtitles from all segments
  const allSubtitles = [];

  segmentResults.forEach(result => {
    if (result.subtitles && Array.isArray(result.subtitles)) {
      // Ensure each subtitle is within its segment bounds
      const segment = result.segment;
      result.subtitles.forEach(subtitle => {
        // Validate and clip subtitle timing to segment bounds
        const clippedSubtitle = {
          ...subtitle,
          start: Math.max(subtitle.start, segment.start),
          end: Math.min(subtitle.end, segment.end),
          segmentIndex: segment.index // Track which segment this came from
        };

        // Only add if the subtitle has valid duration after clipping
        if (clippedSubtitle.start < clippedSubtitle.end) {
          allSubtitles.push(clippedSubtitle);
        }
      });
    }
  });

  // Sort subtitles by start time
  allSubtitles.sort((a, b) => a.start - b.start);
  // PERFORMANCE: Only log for significant merges
  if (allSubtitles.length > 100 || isFirstOrFinal) {
    dbg(`[MergeParallelSubtitles] Collected ${allSubtitles.length} total subtitles before deduplication`);
  }

  // Remove duplicates and overlaps
  const mergedSubtitles = [];
  let lastSubtitle = null;
  let duplicatesRemoved = 0;
  let overlapsAdjusted = 0;

  allSubtitles.forEach(subtitle => {
    if (!lastSubtitle) {
      mergedSubtitles.push(subtitle);
      lastSubtitle = subtitle;
    } else {
      // Check for overlap or duplicate
      const isOverlapping = subtitle.start < lastSubtitle.end;
      const isDuplicate = Math.abs(subtitle.start - lastSubtitle.start) < 0.1 &&
                         subtitle.text === lastSubtitle.text;

      if (isDuplicate) {
        // Skip duplicate
        duplicatesRemoved++;
        return;
      } else if (isOverlapping) {
        // Handle overlap by adjusting timing
        overlapsAdjusted++;
        // If subtitles are from different segments, prefer boundary adjustment
        if (lastSubtitle.segmentIndex !== subtitle.segmentIndex) {
          // Adjust the end of the previous subtitle to the start of the current one
          lastSubtitle.end = Math.min(lastSubtitle.end, subtitle.start);
        }
        mergedSubtitles.push(subtitle);
        lastSubtitle = subtitle;
      } else {
        // No overlap, add normally
        mergedSubtitles.push(subtitle);
        lastSubtitle = subtitle;
      }
    }
  });

  // Clean up segment tracking info
  const finalSubtitles = mergedSubtitles.map(({ segmentIndex, ...subtitle }) => subtitle);

  // PERFORMANCE: Only log merge results for significant operations
  const stats = {
    input: allSubtitles.length,
    output: finalSubtitles.length,
    duplicatesRemoved,
    overlapsAdjusted,
    subtitlesLost: allSubtitles.length - finalSubtitles.length
  };

  // Only log if there were actual changes or it's a large merge
  if (duplicatesRemoved > 0 || overlapsAdjusted > 0 || allSubtitles.length > 100 || isFirstOrFinal) {
    dbg(`[MergeParallelSubtitles] Merge complete:`, stats);
  }

  return finalSubtitles;
};

/**
 * Calculate estimated tokens for parallel processing
 * @param {Array} segments - Array of segments to process
 * @param {Object} options - Processing options (fps, mediaResolution, etc.)
 * @returns {Object} Token usage information
 */
export const calculateParallelTokenUsage = (segments, options) => {
  const { fps, mediaResolution } = options;
  const frameTokens = mediaResolution === 'low' ? 64 : 256;
  const audioTokens = 32; // tokens per second for audio

  let totalTokens = 0;
  const segmentTokens = segments.map(segment => {
    const duration = segment.end - segment.start;
    const tokens = Math.round(duration * (fps * frameTokens + audioTokens));
    totalTokens += tokens;
    return {
      segment,
      tokens,
      duration
    };
  });

  return {
    totalTokens,
    segmentTokens,
    averageTokensPerSegment: Math.round(totalTokens / segments.length),
    maxTokensPerSegment: Math.max(...segmentTokens.map(s => s.tokens))
  };
};

/**
 * Create a progress tracker for parallel requests
 */
export class ParallelProgressTracker {
  constructor(totalSegments, onProgress) {
    this.totalSegments = totalSegments;
    this.segmentProgress = new Array(totalSegments).fill(0);
    this.segmentStatus = new Array(totalSegments).fill('pending');
    this.onProgress = onProgress;
    this.startTime = Date.now();
  }

  updateSegmentProgress(segmentIndex, progress, status = 'processing') {
    this.segmentProgress[segmentIndex] = progress;
    this.segmentStatus[segmentIndex] = status;

    const overallProgress = this.calculateOverallProgress();
    const elapsedTime = Date.now() - this.startTime;

    if (this.onProgress) {
      this.onProgress({
        overallProgress,
        segmentProgress: [...this.segmentProgress],
        segmentStatus: [...this.segmentStatus],
        elapsedTime,
        estimatedTimeRemaining: this.estimateTimeRemaining()
      });
    }
  }

  calculateOverallProgress() {
    const sum = this.segmentProgress.reduce((a, b) => a + b, 0);
    return sum / this.totalSegments;
  }

  estimateTimeRemaining() {
    const progress = this.calculateOverallProgress();
    if (progress === 0) return null;

    const elapsedTime = Date.now() - this.startTime;
    const estimatedTotal = elapsedTime / progress;
    return estimatedTotal - elapsedTime;
  }

  markSegmentComplete(segmentIndex) {
    this.updateSegmentProgress(segmentIndex, 100, 'complete');
  }

  markSegmentFailed(segmentIndex, error) {
    this.segmentStatus[segmentIndex] = 'failed';
    this.segmentError = this.segmentError || {};
    this.segmentError[segmentIndex] = error;

    if (this.onProgress) {
      this.onProgress({
        overallProgress: this.calculateOverallProgress(),
        segmentProgress: [...this.segmentProgress],
        segmentStatus: [...this.segmentStatus],
        error: { segmentIndex, error }
      });
    }
  }

  isComplete() {
    return this.segmentStatus.every(status =>
      status === 'complete' || status === 'failed'
    );
  }

  hasFailures() {
    return this.segmentStatus.includes('failed');
  }

  getFailedSegments() {
    return this.segmentStatus
      .map((status, index) => status === 'failed' ? index : null)
      .filter(index => index !== null);
  }
}
